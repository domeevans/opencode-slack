#!/bin/sh
# Installs a release tag as a Git plugin on one stock OpenCode host, in an isolated HOME, and checks that the plugin
# loads: the running service lists it at the tag, its status RPC answers, and its skill is listed. The release workflow
# runs it once per host; it runs locally the same way, with no other change.
#
#   sh scripts/check-release-plugin-add.sh <host version> <checkout dir> <tag> <work dir> <skill id> <status rpc id>
#
# The stock host is the @opencode/cli package at that version, from npm, installed with lifecycle scripts off. Nothing
# here reads or writes a credential, and the work dir is removed first. A status that reports tested: false for this
# host is printed as a warning: the plugin loads, but its own TESTED_HOSTS does not list the host.
set -eu

if [ "$#" -ne 6 ]; then
  echo "usage: $0 <host version> <checkout dir> <tag> <work dir> <skill id> <status rpc id>" >&2
  exit 2
fi
version="$1"
checkout="$2"
tag="$3"
work="$4"
skill="$5"
rpc="$6"

fail() {
  echo "check-release-plugin-add: $version: $1" >&2
  exit 1
}

stop() {
  "$bin" service stop >/dev/null 2>&1 || true
}

rm -rf "$work"
mkdir -p "$work/stock" "$work/home" "$work/project"
npm install --prefix "$work/stock" --ignore-scripts --no-audit --no-fund "@opencode/cli@$version" >/dev/null 2>&1 || fail "could not install @opencode/cli@$version"
bin="$(find "$work/stock/node_modules/@opencode" -path '*/bin/opencode' -type f | head -n 1)"
[ -n "$bin" ] || fail "no opencode binary in @opencode/cli@$version"
chmod +x "$bin"

# An isolated profile: its own HOME (so the global plugin config is this one) and its own service port.
export HOME="$work/home"
(cd "$work/project" && git init -q)
port="$(node -e 'const s = require("net").createServer(); s.listen(0, () => { console.log(s.address().port); s.close() })')"
"$bin" service set port "$port" >/dev/null 2>&1 || fail "could not set the service port"

"$bin" plugin add "git+file://$checkout#$tag" >"$work/add.log" 2>&1 || { cat "$work/add.log" >&2; fail "plugin add of $tag failed"; }

"$bin" service start >"$work/service.log" 2>&1 || { cat "$work/service.log" >&2; fail "the service did not start"; }

# Plugins load after the server answers, so the status RPC is the wait.
status=""
i=0
while [ "$i" -lt 90 ]; do
  status="$("$bin" api POST "/api/rpc/$rpc/status" -H "x-opencode-directory: $work/project" -d '{"input":{}}' 2>/dev/null || true)"
  case "$status" in *'"state"'*) break ;; esac
  i=$((i + 1))
  sleep 1
done
case "$status" in *'"state"'*) ;; *) stop; fail "the status RPC $rpc did not answer" ;; esac

(cd "$work/project" && "$bin" plugin list >"$work/plugins.txt" 2>&1) || { stop; fail "plugin list failed"; }
grep -q "#$tag" "$work/plugins.txt" || { cat "$work/plugins.txt" >&2; stop; fail "the plugin list does not show $tag"; }

skills="$("$bin" api GET /api/skill -H "x-opencode-directory: $work/project" 2>/dev/null || true)"
case "$skills" in *"\"id\":\"$skill\""*) ;; *) stop; fail "the skill $skill is not listed" ;; esac

stop
case "$status" in *'"tested":true'*) tested="tested on $version" ;; *) tested="WARN: the plugin reports tested: false on $version" ;; esac
echo "ok: $version loads $tag ($rpc status answers, skill $skill is listed; $tested)"
