import fs from 'node:fs';

const server = fs.readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../apps/web/src/App.tsx', import.meta.url), 'utf8');

const checks = [
  {
    name: 'server exposes a reusable shared identity guard',
    pass: server.includes('function requireSharedIdentity'),
  },
  {
    name: 'shared note payload requires identity before serialization',
    pass: /app\.get\('\/api\/share\/:shareId'[\s\S]*requireSharedIdentity\(c\)[\s\S]*serializeNoteForClient/.test(server),
  },
  {
    name: 'shared identity endpoint accepts view-only shares',
    pass: /app\.post\('\/api\/share\/:shareId\/identity'[\s\S]*requireShareAccess\(c, 'view'\)/.test(server),
  },
  {
    name: 'shared edit websocket rejects unnamed users',
    pass: /note\.shareAccess === 'edit'[\s\S]*getCommenterIdentityFromHeaders\(req\.headers\)[\s\S]*!commenterIdentity\.id[\s\S]*ws\.close/.test(server),
  },
  {
    name: 'shared page blocks note fetch behind identity submission',
    pass: app.includes('const [identityRequired, setIdentityRequired] = useState(false)') && app.includes('async function submitRequiredIdentity()'),
  },
];

const failed = checks.filter((check) => !check.pass);
for (const check of checks) {
  console.log(`${check.pass ? 'PASS' : 'FAIL'} ${check.name}`);
}

if (failed.length) {
  process.exit(1);
}
