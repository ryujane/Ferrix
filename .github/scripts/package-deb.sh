#!/usr/bin/env bash
set -euo pipefail
umask 022

app="$1"
version="$2"
output="$3"
app_id=$(jq -er '.id' nsh.json)
architecture=$(dpkg --print-architecture)
staging=$(mktemp -d)
trap 'rm -rf "$staging"' EXIT

package="$staging/package"
app_dir="$package/usr/lib/ferrix"
install -d "$package/DEBIAN" "$package/usr/bin" "$package/usr/share/applications" "$staging/debian"
install -Dm755 "$app/Ferrix" "$app_dir/Ferrix"
cp -a "$app/nsh" "$app_dir/"
ln -s ../lib/ferrix/Ferrix "$package/usr/bin/ferrix"
sed 's|^Exec=[^ ]*|Exec=/usr/bin/ferrix|' "$app/$app_id.desktop" > "$package/usr/share/applications/$app_id.desktop"
install -Dm644 "$app/$app_id.png" "$package/usr/share/pixmaps/$app_id.png"

# dpkg-shlibdeps reads source metadata separately from the binary package control file.
printf 'Source: ferrix\n\nPackage: ferrix\nArchitecture: %s\n' "$architecture" > "$staging/debian/control"
shlibs=$(cd "$staging" && dpkg-shlibdeps -O -e "$app_dir/Ferrix")
if [[ $shlibs != shlibs:Depends=?* ]]; then
  echo 'Could not resolve shared library dependencies for Ferrix.' >&2
  exit 1
fi

cat > "$package/DEBIAN/control" <<EOF
Package: ferrix
Version: $version
Section: database
Priority: optional
Architecture: $architecture
Maintainer: Ferrix <37573832+ryujane@users.noreply.github.com>
Depends: ${shlibs#shlibs:Depends=}
Homepage: https://github.com/ryujane/Ferrix
Description: Native Redis desktop client
EOF

dpkg-deb --root-owner-group --build "$package" "$output"
