#!/usr/bin/env bash
set -euo pipefail
OUT="${1:?usage: gen.sh <outdir>}"
mkdir -p "$OUT"; cd "$OUT"
DAYS=3650
SAN="subjectAltName=DNS:localhost,IP:127.0.0.1"
newca() {
  openssl req -x509 -newkey rsa:2048 -nodes -keyout "$1.key" -out "$1.pem" \
    -subj "/CN=$2" -days "$DAYS" \
    -addext "basicConstraints=critical,CA:TRUE" \
    -addext "keyUsage=critical,keyCertSign,cRLSign" 2>/dev/null
}
leaf() {
  openssl req -newkey rsa:2048 -nodes -keyout "$1.key" -out "$1.csr" -subj "/CN=$2" 2>/dev/null
  { echo "$SAN"; echo "keyUsage=critical,digitalSignature,keyEncipherment"; echo "extendedKeyUsage=serverAuth"; } > "$1.ext"
  openssl x509 -req -in "$1.csr" -CA "$3.pem" -CAkey "$3.key" -CAcreateserial \
    -out "$1.pem" -days "$DAYS" -extfile "$1.ext" 2>/dev/null
  rm -f "$1.csr" "$1.ext"
}
newca ca-good  "klodi-test-ca-good-keyusage"
newca ca-wrong "klodi-test-ca-wrong-signer"
leaf  leaf-good "localhost" ca-good
openssl req -newkey rsa:2048 -nodes -keyout int-nokeyusage.key -out int-nokeyusage.csr \
  -subj "/CN=klodi-test-int-nokeyusage" 2>/dev/null
{ echo "basicConstraints=critical,CA:TRUE"; echo "keyUsage=critical,digitalSignature"; } > int-nokeyusage.ext
openssl x509 -req -in int-nokeyusage.csr -CA ca-good.pem -CAkey ca-good.key -CAcreateserial \
  -out int-nokeyusage.pem -days "$DAYS" -extfile int-nokeyusage.ext 2>/dev/null
rm -f int-nokeyusage.csr int-nokeyusage.ext
leaf  leaf-viachain "localhost" int-nokeyusage
cat leaf-viachain.pem int-nokeyusage.pem > chain-nokeyusage.pem
ls -1
