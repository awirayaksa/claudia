#!/usr/bin/env sh
# A throwaway CA and a certificate for ldap.claudia.test, for compose.ldap.yml.
# The image's built-in default CA has expired, so its generated certificate
# can't be verified; this one is made fresh (valid 30 days) instead.
#
#   sh docker/ldap/make-certs.sh      (writes docker/ldap/certs/, git-ignored)
set -eu
export MSYS_NO_PATHCONV=1 # Git Bash on Windows: keep /CN=… as is

dir="$(cd "$(dirname "$0")" && pwd)/certs"
mkdir -p "$dir"
cd "$dir"

openssl req -x509 -newkey rsa:2048 -nodes -days 30 -subj "/CN=Claudia Test LDAP CA" \
  -keyout ca.key -out ca.crt 2>/dev/null
openssl req -newkey rsa:2048 -nodes -subj "/CN=ldap.claudia.test" \
  -keyout ldap.key -out ldap.csr 2>/dev/null
printf 'subjectAltName=DNS:ldap.claudia.test,DNS:localhost\nextendedKeyUsage=serverAuth\n' > ldap.ext
openssl x509 -req -in ldap.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days 30 \
  -extfile ldap.ext -out ldap.crt 2>/dev/null
rm -f ldap.csr ldap.ext ca.srl ca.key
# DH parameters: the image would otherwise generate them at first start, which
# takes a while. The standard RFC 7919 group is instant; slapd (GnuTLS) reads
# its PKCS#3 "DH PARAMETERS" form, not the X9.42 one -dsaparam writes.
openssl genpkey -genparam -algorithm DH -pkeyopt group:ffdhe2048 -out dhparam.pem 2>/dev/null
# slapd runs as its own user inside the container; a test-only key
chmod 644 ldap.key dhparam.pem
echo "Wrote $dir/{ca.crt,ldap.crt,ldap.key,dhparam.pem}"
