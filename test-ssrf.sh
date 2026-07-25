#!/usr/bin/env bash
# Proves the address guard on /api/convert in both directions: private targets
# are refused (literal, resolved-by-DNS, and reached via redirect) and a real
# public link still comes back with a playable URL.
set -uo pipefail
cd "$(dirname "$0")"
BASE="http://127.0.0.1:${PORT:-4310}"
pass=0; fail=0
ok()   { echo "  ✅ $1"; pass=$((pass+1)); }
bad()  { echo "  ❌ $1"; fail=$((fail+1)); }
enc()  { printf %s "$1" | jq -sRr @uri; }

echo "── blocked: a pasted link may never point at this box ──"
for u in \
  "http://127.0.0.1:4310/" \
  "http://localtest.me/x" \
  "http://169.254.169.254/latest/meta-data/" \
  "http://10.0.0.1/" \
  "http://192.168.1.1/" \
  "http://[::1]/x" \
  "file:///etc/passwd" \
  "gopher://127.0.0.1:11211/_stats"
do
  body=$(curl -s -m 20 "$BASE/api/convert?direct=1&url=$(enc "$u")")
  case "$body" in
    *"Not a valid link"*) ok "refused $u" ;;
    *) bad "ALLOWED $u -> $body" ;;
  esac
done

echo "── the guard walks redirects instead of trusting fetch() ──"
node -e '
const { fetchPublic } = require("./server.js");
const http = require("http");
// A public-looking hop that bounces to link-local. fetch() would follow it
// silently; fetchPublic has to stop at the second hop.
const s = http.createServer((req, res) => {
  res.writeHead(302, { Location: "http://169.254.169.254/latest/meta-data/" });
  res.end();
}).listen(0, "127.0.0.1", async () => {
  const port = s.address().port;
  let out = "no-throw";
  try { await fetchPublic(`http://127.0.0.1:${port}/`, {}); }
  catch (e) { out = e.message; }
  console.log(out === "blocked" ? "BLOCKED" : "LEAKED:" + out);
  s.close();
  // And a redirect chain that never ends must not spin forever.
  const loop = http.createServer((req, res) => {
    res.writeHead(302, { Location: "/again" });
    res.end();
  }).listen(0, "127.0.0.1", async () => {
    let m = "no-throw";
    try { await fetchPublic(`http://127.0.0.1:${loop.address().port}/`, {}); }
    catch (e) { m = e.message; }
    console.log("LOOP:" + m);
    loop.close();
  });
});
' > /tmp/ssrf-redir.$$ 2>&1
grep -q "^BLOCKED" /tmp/ssrf-redir.$$ && ok "redirect to link-local refused" \
  || bad "redirect hop not checked: $(cat /tmp/ssrf-redir.$$)"
grep -q "^LOOP:" /tmp/ssrf-redir.$$ && ok "endless redirect chain terminates" \
  || bad "redirect loop did not terminate"
rm -f /tmp/ssrf-redir.$$

echo "── allowed: a real public link still resolves ──"
body=$(curl -s -m 90 "$BASE/api/convert?direct=1&url=$(enc 'https://www.youtube.com/watch?v=dQw4w9WgXcQ')")
case "$body" in
  *'"ok":true'*'"url":"https://'*) ok "public link returned a direct URL" ;;
  *) bad "public link broke -> $(printf %.160s "$body")" ;;
esac

echo
echo "ssrf: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
