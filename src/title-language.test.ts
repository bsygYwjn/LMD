import assert from 'node:assert/strict';
import { chooseTitle, localizedDisplay } from './title-language.ts';

assert.equal(chooseTitle('中文', 'Original', 'zh'), '中文');
assert.equal(chooseTitle('中文', 'Original', 'original'), 'Original');
assert.equal(chooseTitle('', 'Original', 'zh'), 'Original');
assert.equal(chooseTitle('中文', '', 'original'), '中文');
const source = { title: '作品', originalTitle: 'Work', seriesTitle: '作品', episodeTitle: '已发布集名', originalEpisodeTitle: 'Official Episode', alias: 'old', season: 3, episode: 1 };
const original = localizedDisplay(source, 'original');
assert.equal(original.alias, 'Work - S03E01 · Official Episode');
assert.equal(original.episode, 1);
assert.ok(original.searchTitles.includes('已发布集名'));
assert.ok(original.searchTitles.includes('Official Episode'));
assert.equal(source.alias, 'old');
assert.equal(localizedDisplay({ ...source, episodeTitle: '' }, 'zh').episodeTitle, 'Official Episode');
console.log('title language: browser-independent bilingual fallback, published episode fallback, search names, immutable season/episode passed');
