// node_modules 의 고정 버전 UMD 번들을 vendor/supabase.js 로 복사하거나(--verify 면) 같은지 확인한다.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const src = new URL('./node_modules/@supabase/supabase-js/dist/umd/supabase.js', import.meta.url);
const dst = new URL('./supabase.js', import.meta.url);
const ver = JSON.parse(readFileSync(new URL('./node_modules/@supabase/supabase-js/package.json', import.meta.url))).version;
const sha = (b) => createHash('sha256').update(b).digest('hex');
const a = readFileSync(src);
if (process.argv.includes('--verify')) {
  const b = readFileSync(dst);
  if (sha(a) !== sha(b)) { console.error(`MISMATCH vendor/supabase.js != @supabase/supabase-js@${ver}`); process.exit(1); }
  console.log(`OK @supabase/supabase-js@${ver} sha256 ${sha(b)}`);
} else {
  writeFileSync(dst, a);
  console.log(`copied @supabase/supabase-js@${ver} sha256 ${sha(a)}`);
}
