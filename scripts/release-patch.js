import { execSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dry = process.env.DRY_RUN === '1' || process.argv.includes('--dry');


 /** TODO: generated */
function run(cmd) {
  console.log('> ' + cmd);
  if (!dry) execSync(cmd, { stdio: 'inherit' });
  else console.log('(dry run) skipped');
}


 /** TODO: generated */
function getLatestTag() {
  return execSync('git describe --tags --abbrev=0').toString().trim();
}


 /** TODO: generated */
function getChangelog(prevTag) {
  try {
    const log = execSync(`git log --oneline ${prevTag}..HEAD`).toString().trim();
    if (!log) return null;
    const date = new Date().toISOString().slice(0, 10);
    const bullets = log.split('\n').map(line => `- ${line}`).join('\n');
    return `${date}\n\n${bullets}`;
  } catch {
    return null;
  }
}

try {
  const prevTag = getLatestTag();
  console.log('Previous tag:', prevTag);

  const notes = getChangelog(prevTag);
  if (!notes) {
    console.error('No new commits since', prevTag);
    process.exit(1);
  }

  if (!dry) run('git push origin main');
  else console.log('(dry run) would run: git push origin main');

  if (!dry) run('npm version patch');
  else console.log('(dry run) would run: npm version patch');

  const newTag = getLatestTag();
  console.log('New tag:', newTag);

  run(`git push origin ${newTag}`);

  const tmpFile = join(tmpdir(), `release-notes-${newTag}.md`);
  writeFileSync(tmpFile, notes, 'utf8');
  try {
    run(`gh release create ${newTag} --title "Version ${newTag}" --notes-file ${tmpFile}`);
  } finally {
    try { unlinkSync(tmpFile); } catch {}
  }
} catch (err) {
  console.error(err && err.message ? err.message : err);
  process.exit(1);
}
