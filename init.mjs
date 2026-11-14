import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url));
const target=path.join(root,'.env');
try {await fs.access(target);console.error('.env already exists. Nothing was overwritten.');process.exit(1);} catch(e) {if(e.code!=='ENOENT')throw e;}
const original=await fs.readFile(path.join(root,'.env.example'),'utf8');
const configured=original
  .replace('SESSION_SECRET=CHANGE_ME_base64_secret',`SESSION_SECRET=${crypto.randomBytes(48).toString('base64')}`)
  .replace('ENCRYPTION_KEY=CHANGE_ME_base64_32_byte_key',`ENCRYPTION_KEY=${crypto.randomBytes(32).toString('base64')}`);
await fs.writeFile(target,configured,{mode:0o600,flag:'wx'});
console.log('Created .env with randomly generated encryption and session keys.');
console.log('Next: edit .env and set ADMIN_PASSWORD, APP_BASE_URL, PUBLIC_BASE_URL, and Instagram credentials (when ready).');
console.log('Then run: npm start');
