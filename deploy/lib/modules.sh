# shellcheck shell=bash
# What a build's node_modules output must look like before root moves it into a release. Source it; do not run it.
# Used by release-remote.sh and tested on its own in deploy/test/release.sh.

# safe_link_target <dir of the link, relative to the release root> <link target>: true when the target stays inside the release.
# Absolute targets are refused. A relative one may climb with leading ../ parts (never past the root), then only descend. A ".." after a
# plain name is refused, so the answer does not depend on where other links lead.
safe_link_target() {
  local dir="$1" target="$2" depth=0 part seen_name=0 IFS=/ answer=0
  [ -n "$target" ] || return 1
  case "$target" in /*) return 1 ;; esac
  set -f # the parts are split on "/" below, and a "*" in a name must stay a name
  if [ "$dir" != "." ]; then
    # shellcheck disable=SC2086
    set -- $dir
    depth=$#
  fi
  # shellcheck disable=SC2086
  set -- $target
  for part in "$@"; do
    case "$part" in
      '' | .) ;;
      ..)
        if [ "$seen_name" -eq 1 ]; then answer=1; fi
        depth=$((depth - 1))
        if [ "$depth" -lt 0 ]; then answer=1; fi
        ;;
      *) seen_name=1 ;;
    esac
  done
  set +f
  return "$answer"
}

# check_modules <dir>: what the sandboxed unpack produced must be plain. Dies with the reason.
check_modules() {
  local dir="$1" odd f l t relp
  odd="$(find "$dir" ! -type f ! -type d ! -type l -print -quit)"
  [ -z "$odd" ] || die "the build output holds something that is not a file, folder or link: ${odd#"$dir"/}"
  odd="$(find "$dir" -type f -links +1 -print -quit)"
  [ -z "$odd" ] || die "the build output holds a hard link: ${odd#"$dir"/}"
  odd="$(find "$dir" -type f -perm -4000 -print -quit)"
  [ -z "$odd" ] || die "the build output holds a set-uid file: ${odd#"$dir"/}"
  odd="$(find "$dir" -type f -perm -2000 -print -quit)"
  [ -z "$odd" ] || die "the build output holds a set-gid file: ${odd#"$dir"/}"
  while IFS= read -r -d '' f; do
    relp="${f#"$dir"/}"
    case "/$relp/" in */node_modules/*) ;; *) die "the build output holds a file outside node_modules: $relp" ;; esac
  done < <(find "$dir" -mindepth 1 \( -type f -o -type l \) -print0)
  while IFS= read -r -d '' l; do
    t="$(readlink "$l")"
    relp="${l#"$dir"/}"
    f="$(dirname "$relp")"
    safe_link_target "$f" "$t" || die "the link $relp -> $t leaves the release. Refusing this release."
  done < <(find "$dir" -type l -print0)
}

