#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { sortChronicleContent, stripChronicleAnalysis } = require('../chronicle-utils');

const target = path.resolve(process.argv[2] || 'source/_posts/ai-chronicle.md');
const current = fs.readFileSync(target, 'utf8');
const normalized = sortChronicleContent(stripChronicleAnalysis(current));

if (normalized === current) {
  console.log(`[编年史] 已经是倒序简洁格式: ${target}`);
  process.exit(0);
}

fs.writeFileSync(target, normalized, 'utf8');
console.log(`[编年史] 已移除分析段落并按时间倒序: ${target}`);
