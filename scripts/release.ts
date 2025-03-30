import { execSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const packageJsonPath = join(process.cwd(), 'package.json');

function getCurrentVersion(): string {
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
  return packageJson.version;
}

function updateVersion(version: string, type: 'patch' | 'minor' | 'major'): string {
  const [major, minor, patch] = version.split('.').map(Number);
  
  switch (type) {
    case 'major':
      return `${major + 1}.0.0`;
    case 'minor':
      return `${major}.${minor + 1}.0`;
    case 'patch':
      return `${major}.${minor}.${patch + 1}`;
    default:
      throw new Error(`Invalid version type: ${type}`);
  }
}

function updatePackageJson(version: string) {
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
  packageJson.version = version;
  writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + '\n');
}

function runCommand(command: string) {
  console.log(`Running: ${command}`);
  try {
    execSync(command, { stdio: 'inherit' });
  } catch (error) {
    console.error(`Command failed: ${command}`);
    process.exit(1);
  }
}

function main() {
  const type = process.argv[2] as 'patch' | 'minor' | 'major';
  
  if (!type || !['patch', 'minor', 'major'].includes(type)) {
    console.error('Please specify version type: patch, minor, or major');
    process.exit(1);
  }

  // Get current version and calculate new version
  const currentVersion = getCurrentVersion();
  const newVersion = updateVersion(currentVersion, type);
  
  console.log(`Current version: ${currentVersion}`);
  console.log(`New version: ${newVersion}`);

  // Run tests
  console.log('\nRunning tests...');
  runCommand('pnpm test');

  // Build the package
  console.log('\nBuilding package...');
  runCommand('pnpm build');

  // Update version in package.json
  console.log('\nUpdating version...');
  updatePackageJson(newVersion);

  // Create git commit and tag
  console.log('\nCreating git commit and tag...');
  runCommand(`git add package.json`);
  runCommand(`git commit -m "chore: release v${newVersion}"`);
  runCommand(`git tag -a v${newVersion} -m "Release v${newVersion}"`);

  // Publish to npm
  console.log('\nPublishing to npm...');
  runCommand('npm publish');

  // Push changes to git
  console.log('\nPushing changes to git...');
  runCommand('git push');
  runCommand(`git push --tags`);

  console.log('\nRelease completed successfully! 🎉');
}

main(); 