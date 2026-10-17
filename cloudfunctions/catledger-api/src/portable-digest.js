// SHA-256/UTF-8 primitives shared with the native mini program. No Node globals.
const K = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
  0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
  0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
  0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
  0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
  0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
  0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
  0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]
function utf8(value) {
  const bytes = []
  for (const char of String(value)) {
    let cp = char.codePointAt(0)
    if (cp >= 0xd800 && cp <= 0xdfff) cp = 0xfffd
    if (cp < 0x80) bytes.push(cp)
    else if (cp < 0x800) bytes.push(0xc0 | cp >> 6, 0x80 | cp & 63)
    else if (cp < 0x10000) bytes.push(0xe0 | cp >> 12, 0x80 | cp >> 6 & 63, 0x80 | cp & 63)
    else bytes.push(0xf0 | cp >> 18, 0x80 | cp >> 12 & 63, 0x80 | cp >> 6 & 63, 0x80 | cp & 63)
  }
  return bytes
}
function byteLength(value) {
  let size = 0
  for (const char of String(value)) { const cp = char.codePointAt(0); size += cp < 128 ? 1 : cp < 2048 ? 2 : cp < 65536 ? 3 : 4 }
  return size
}
const rotate = (v, n) => v >>> n | v << (32 - n)
function sha256(value) {
  const bytes = typeof value === 'string' ? utf8(value) : Array.from(value)
  const length = bytes.length
  bytes.push(128)
  while (bytes.length % 64 !== 56) bytes.push(0)
  const high = Math.floor(length / 0x20000000), low = length * 8 >>> 0
  for (const part of [high, low]) for (let shift = 24; shift >= 0; shift -= 8) bytes.push(part >>> shift & 255)
  const h = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19], w = new Int32Array(64)
  for (let start = 0; start < bytes.length; start += 64) {
    for (let i = 0; i < 16; i++) { const p = start + i * 4; w[i] = bytes[p] << 24 | bytes[p+1] << 16 | bytes[p+2] << 8 | bytes[p+3] }
    for (let i = 16; i < 64; i++) {
      const x = w[i-15], y = w[i-2]
      w[i] = w[i-16] + (rotate(x,7) ^ rotate(x,18) ^ x >>> 3) + w[i-7] + (rotate(y,17) ^ rotate(y,19) ^ y >>> 10) | 0
    }
    let [a,b,c,d,e,f,g,z] = h
    for (let i = 0; i < 64; i++) {
      const t1 = z + (rotate(e,6) ^ rotate(e,11) ^ rotate(e,25)) + (e & f ^ ~e & g) + K[i] + w[i] | 0
      const t2 = (rotate(a,2) ^ rotate(a,13) ^ rotate(a,22)) + (a & b ^ a & c ^ b & c) | 0
      z=g; g=f; f=e; e=d+t1|0; d=c; c=b; b=a; a=t1+t2|0
    }
    for (const [i,v] of [a,b,c,d,e,f,g,z].entries()) h[i] = h[i] + v | 0
  }
  return h.map(v => (v >>> 0).toString(16).padStart(8,'0')).join('')
}
function digestParts(...values) { return sha256(values.map(value => { const text = String(value); return byteLength(text) + ':' + text }).join('')) }
module.exports = { sha256, byteLength, digestParts }
