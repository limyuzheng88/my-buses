// Creates the key pair that lets this app send push notifications to your phone.
// Run once: node generate-vapid.mjs
// Then add both values as Secrets on the Cloudflare Worker. Keep the private key to yourself.

const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const b64u = (buf) => Buffer.from(buf).toString('base64url');
const publicKey = b64u(await crypto.subtle.exportKey('raw', pair.publicKey));
const privateKey = (await crypto.subtle.exportKey('jwk', pair.privateKey)).d;

console.log('Add these two Secrets to the Worker (Settings, Variables and Secrets):\n');
console.log(`VAPID_PUBLIC_KEY\n${publicKey}\n`);
console.log(`VAPID_PRIVATE_KEY\n${privateKey}\n`);
console.log('If you ever run this again and replace them, open the app and turn alerts on again on each phone.');
