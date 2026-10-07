// Stand-in for a browser push service plus a pretend phone that decrypts like a browser (RFC 8291).
import http from 'node:http';
import nodeCrypto from 'node:crypto';
const b64u = (b) => Buffer.from(b).toString('base64url');
const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
export const VAPID_PUBLIC_KEY = b64u(await crypto.subtle.exportKey('raw', pair.publicKey));
export const VAPID_PRIVATE_KEY = (await crypto.subtle.exportKey('jwk', pair.privateKey)).d;
const ua = nodeCrypto.createECDH('prime256v1'); ua.generateKeys();
const auth = nodeCrypto.randomBytes(16);
export const keys = { p256dh: b64u(ua.getPublicKey()), auth: b64u(auth) };
export const received = [];
export const ctl = { respond: 201 };
export const server = http.createServer((req, res) => {
  const chunks = []; req.on('data', (c) => chunks.push(c)); req.on('end', () => {
    const body = Buffer.concat(chunks); const out = { path: req.url, message: null, ttl: Number(req.headers.ttl) };
    if (body.length) {
      const salt = body.subarray(0, 16), idlen = body[20], asPub = body.subarray(21, 21 + idlen), ct = body.subarray(21 + idlen);
      const ikm = Buffer.from(nodeCrypto.hkdfSync('sha256', ua.computeSecret(asPub), auth, Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPub]), 32));
      const cek = Buffer.from(nodeCrypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
      const nonce = Buffer.from(nodeCrypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
      const d = nodeCrypto.createDecipheriv('aes-128-gcm', cek, nonce); d.setAuthTag(ct.subarray(ct.length - 16));
      const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
      out.message = JSON.parse(plain.subarray(0, plain.length - 1).toString());
    }
    received.push(out); res.writeHead(ctl.respond); res.end();
  });
});
