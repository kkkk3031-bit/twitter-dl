#!/usr/bin/env bash
# Whole-conversation test: API + real browser, English AND Arabic threads.
#
# Checks what actually matters about a scraped conversation — that the tweet
# itself is there, that every reply carries its own x.com address, that the text
# is complete rather than truncated, that Arabic survives end to end, and that
# the page renders the lot in order. Run it after touching comments.js, the
# /api/comments route, or the conversation view.
#
#   ./test-comments.sh [base-url]
set -uo pipefail
BASE="${1:-http://127.0.0.1:4310}"
PASS=0
FAIL=0

ok()   { echo "  ✅ $1"; PASS=$((PASS+1)); }
bad()  { echo "  ❌ $1"; FAIL=$((FAIL+1)); }

check_thread() {  # <label> <tweet-url> <expect-arabic:0|1>
  local label="$1" url="$2" want_ar="$3"
  echo ""
  echo "### $label"
  local json
  json=$(curl -s -m 180 "$BASE/api/comments?url=$url")
  BASE="$BASE" LABEL="$label" WANT_AR="$want_ar" python3 - "$json" <<'PY'
import json, math, os, re, sys, urllib.request
raw = sys.argv[1]
try:
    d = json.loads(raw)
except Exception as e:
    print(f"  ❌ response is not JSON ({e}): {raw[:120]}")
    sys.exit(9)
if not d.get("ok"):
    print(f"  ❌ api error: {str(d.get('error'))[:160]}")
    sys.exit(9)

reps = d.get("replies", [])
fails = 0
def ok(m):  print(f"  ✅ {m}")
def bad(m):
    global fails
    fails += 1
    print(f"  ❌ {m}")

ok(f"{d['count']} replies via {d['via']} in {d.get('pages_read')} page loads (partial={d['partial']})")

# the tweet that started it must lead the conversation
m = d.get("main")
if m and m.get("handle") and m.get("text"):
    ok(f"opening tweet present: @{m['handle']}")
else:
    bad("opening tweet (main) missing")

# no login anywhere in the loop
if d.get("login_required") is False:
    ok("login_required=false")
else:
    bad("login_required not false")

# every reply addressable on X
no_url = [r for r in reps if not r.get("url")]
if reps and not no_url:
    ok(f"all {len(reps)} replies carry an x.com URL")
else:
    bad(f"{len(no_url)} replies without a URL")

bad_url = [r for r in reps if r.get("url") and not re.fullmatch(r"https://x\.com/[A-Za-z0-9_]+/status/\d+", r["url"])]
if not bad_url:
    ok("URL shape valid")
else:
    bad(f"{len(bad_url)} malformed URLs e.g. {bad_url[0]['url']}")

# unique comments, not the same page counted twice
ids = [r["id"] for r in reps if r.get("id")]
if len(ids) == len(set(ids)) and len(ids) == len(reps):
    ok(f"{len(set(ids))} unique reply ids, no duplicates")
else:
    bad(f"{len(reps)} replies but {len(set(ids))} unique ids")

# oldest → newest, first tweeter through last commenter
ts = [r["ts"] for r in reps if r.get("ts")]
if len(ts) >= 2 and ts == sorted(ts):
    ok(f"chronological: {ts[0][:16]} → {ts[-1][:16]}")
elif len(ts) < 2:
    bad("not enough timestamps to order the conversation")
else:
    bad("replies out of chronological order")

# full text, not clipped
empty = [r for r in reps if not (r.get("text") or "").strip() and not r.get("images")]
if not empty:
    ok("no empty reply bodies")
else:
    bad(f"{len(empty)} replies with no text and no image")
# Truncation can only be judged against the source, not by looking for a
# trailing ellipsis — people type those themselves ("blow dust off the ole Vita……").
# So take the longest replies and diff them against X's own copy of that tweet.
def x_token(i):
    v = (int(i) / 1e15) * math.pi
    out, n = "", v
    whole = int(n)
    frac = n - whole
    digits = "0123456789abcdefghijklmnopqrstuvwxyz"
    w = ""
    while whole:
        w = digits[whole % 36] + w
        whole //= 36
    w = w or "0"
    f = ""
    for _ in range(20):
        frac *= 36
        d = int(frac)
        f += digits[d]
        frac -= d
    return re.sub(r"(0+|\.)", "", w + "." + f)

def x_text(i):
    u = f"https://cdn.syndication.twimg.com/tweet-result?id={i}&token={x_token(i)}&lang=en"
    req = urllib.request.Request(u, headers={"User-Agent": "Mozilla/5.0", "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.load(r).get("text") or ""

def norm(t):
    t = re.sub(r"^(@\w+\s+)+", "", t or "")          # nitter keeps mentions separately
    t = re.sub(r"https://t\.co/\w+", "", t)          # link shorteners differ per render
    return re.sub(r"\s+", " ", t).strip()

# Direction matters. X's public endpoint itself clips long-form tweets around
# 280 chars (verified: a 519-char reply came back as 291, cut mid-sentence),
# while the mirror renders them whole — so "we have more" is a pass and only
# "we have less" is truncation on our side.
sample = sorted([r for r in reps if r.get("id")], key=lambda r: -len(r.get("text") or ""))[:3]
short, diverged, richer, exact = [], [], 0, 0
for r in sample:
    try:
        src = norm(x_text(r["id"]))
    except Exception:
        continue                                       # deleted/protected reply, not our bug
    mine = norm(r["text"])
    if not src or src == mine:
        exact += 1
    elif mine.startswith(src):
        richer += 1                                    # X clipped it, we did not
    elif src.startswith(mine):
        short.append((r["id"], mine[-45:], src[-45:]))
    else:
        diverged.append((r["id"], mine[-45:], src[-45:]))
if not short and not diverged:
    ok(f"text verified against X on {exact + richer} replies "
       f"({exact} identical, {richer} fuller than X's own clipped copy)")
elif short:
    bad(f"OUR text is short on {len(short)}: scraped …{short[0][1]!r} vs X …{short[0][2]!r}")
else:
    bad(f"text diverges from X on {len(diverged)}: scraped …{diverged[0][1]!r} vs X …{diverged[0][2]!r}")

longest = max((len(r.get("text") or "") for r in reps), default=0)
ok(f"longest reply {longest} chars")

# script coverage
ar = [r for r in reps if re.search(r"[؀-ۿ]", r.get("text") or "")]
en = [r for r in reps if re.search(r"[A-Za-z]{3}", r.get("text") or "")]
if en:
    ok(f"{len(en)} replies with English text")
else:
    bad("no English replies found")
if os.environ["WANT_AR"] == "1":
    if ar:
        ok(f"{len(ar)} Arabic replies, e.g. @{ar[0]['handle']}: {ar[0]['text'][:40]}")
        mojibake = [r for r in ar if "Ø" in r["text"] or "�" in r["text"]]
        if not mojibake:
            ok("Arabic text clean (no mojibake / replacement chars)")
        else:
            bad(f"{len(mojibake)} Arabic replies mangled")
    else:
        bad("expected Arabic replies, found none")
elif ar:
    ok(f"(bonus) {len(ar)} Arabic replies present")

sys.exit(1 if fails else 0)
PY
  local rc=$?
  if [ $rc -eq 0 ]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); fi
}

echo "== whole-conversation tests against $BASE =="

# English thread with one Arabic reply in it
check_thread "EN thread (PSVita CoD)" "https://x.com/i/status/2080676928000790563" 1
# Arabic-first thread — KUNA (Kuwait news agency), replies are Arabic throughout
check_thread "AR thread (KUNA)" "${AR_TWEET:-https://x.com/KUNA_AR/status/2031072051407237500}" 1

echo ""
echo "### browser render"
if node "$(dirname "$0")/test-render.mjs" "$BASE"; then
  ok "page renders the whole conversation (see downloads/shot-conversation.png)"
else
  bad "browser render check failed"
fi

echo ""
echo "== $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ]
