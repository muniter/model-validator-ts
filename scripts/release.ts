import { execSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { parseArgs } from 'node:util';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const packageJsonPath = join(process.cwd(), 'package.json');

function getCurrentVersion(): string {
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
  return packageJson.version;
}

function getLatestNpmVersion(packageName: string): string {
  try {
    const result = execSync(`npm view ${packageName} version`, { encoding: 'utf-8' });
    return result.trim();
  } catch (error) {
    console.log('No previous version found on npm, using current version as base');
    return getCurrentVersion();
  }
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

function askForConfirmation(message: string): Promise<boolean> {
  const readline = require('readline').createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise<boolean>((resolve) => {
    readline.question(`${message} (y/N): `, (answer: string) => {
      readline.close();
      resolve(answer.toLowerCase() === 'y');
    });
  });
}

async function main() {
  // Parse command line arguments
  const { values } = parseArgs({
    options: {
      type: {
        type: 'string',
        short: 't',
        default: 'patch'
      },
      force: {
        type: 'boolean',
        short: 'f',
        default: false
      }
    }
  });

  const type = values.type as 'patch' | 'minor' | 'major';
  
  if (!['patch', 'minor', 'major'].includes(type)) {
    console.error('Please specify a valid version type: patch, minor, or major');
    process.exit(1);
  }

  // Get current and latest versions
  const currentVersion = getCurrentVersion();
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
  const latestNpmVersion = getLatestNpmVersion(packageJson.name);
  const newVersion = updateVersion(currentVersion, type);

  // Run tests
  console.log('\nRunning tests...');
  runCommand('pnpm test -- --run');

  // Run lint
  console.log('\nRunning lint...');
  runCommand('pnpm lint');

  
  console.log(`Current version: ${currentVersion}`);
  console.log(`Latest npm version: ${latestNpmVersion}`);
  console.log(`New version will be: ${newVersion}`);
  if (!values.force) {
    const shouldProceed = await askForConfirmation('Do you want to proceed with this version?');
    if (!shouldProceed) {
      console.log('Release cancelled');
      process.exit(0);
    }
  }

  // Update version in package.json
  console.log('\nUpdating version...');
  updatePackageJson(newVersion);

  // Create git commit and tag
  console.log('\nCreating git commit and tag...');
  runCommand(`git add package.json`);
  runCommand(`git commit -m "chore: release v${newVersion}"`);
  runCommand(`git tag -a v${newVersion} -m "Release v${newVersion}"`);

  // Ask for confirmation before publishing
  if (!values.force) {
    const shouldPublish = await askForConfirmation('Do you want to publish to npm?');
    if (!shouldPublish) {
      console.log('Publishing cancelled');
      process.exit(0);
    }
  }

  // Publish to npm
  console.log('\nPublishing to npm...');
  runCommand('pnpm publish');

  // Push changes to git
  console.log('\nPushing changes to git...');
  runCommand('git push');
  runCommand(`git push --tags`);

  console.log('\nRelease completed successfully! 🎉');
}

main().catch(error => {
  console.error('Release failed:', error);
  process.exit(1);
}); 