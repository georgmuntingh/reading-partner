#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function getGitInfo() {
    try {
        const commit = execSync('git rev-parse HEAD').toString().trim();
        const commitShort = execSync('git rev-parse --short HEAD').toString().trim();
        const branch = execSync('git rev-parse --abbrev-ref HEAD').toString().trim();
        const lastCommitDate = execSync('git log -1 --format=%cI').toString().trim();
        return {
            commit,
            commitShort,
            branch,
            lastCommitDate
        };
    } catch (error) {
        console.warn('Warning: Could not retrieve git information:', error.message);
        return {
            commit: 'unknown',
            commitShort: 'unknown',
            branch: 'unknown',
            lastCommitDate: new Date().toISOString()
        };
    }
}

function generateBuildInfo() {
    const gitInfo = getGitInfo();
    const buildInfo = {
        version: require('../package.json').version,
        buildTime: new Date().toISOString(),
        ...gitInfo
    };

    const outputPath = path.join(__dirname, '..', 'public', 'build-info.json');

    // Ensure public directory exists
    const publicDir = path.dirname(outputPath);
    if (!fs.existsSync(publicDir)) {
        fs.mkdirSync(publicDir, { recursive: true });
    }

    fs.writeFileSync(outputPath, JSON.stringify(buildInfo, null, 2));
    console.log('Build info generated:', outputPath);
    console.log(buildInfo);
}

generateBuildInfo();
