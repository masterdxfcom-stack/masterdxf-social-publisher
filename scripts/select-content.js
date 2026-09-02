const fs = require('fs');

const GITHUB_USER = 'masterdxfcom-stack';
const GITHUB_REPO = 'masterdxf-social-publisher';
const GITHUB_BRANCH = 'main';
const SITE_URL = 'https://masterdxf.com';

function parseSitemap(xmlContent) {
  const designs = [];
  const urlBlocks = xmlContent.split('<url>').slice(1);
  for (const block of urlBlocks) {
    const loc = (block.match(/<loc>(.*?)<\/loc>/) || [])[1];
    const imageLoc = (block.match(/<image:loc>(.*?)<\/image:loc>/) || [])[1];
    const title = (block.match(/<image:title>(.*?)<\/image:title>/) || [])[1];
    if (loc && imageLoc) {
      designs.push({
        page_url: loc.trim(),
        image_url: imageLoc.trim(),
        title: title ? title.trim().replace(/&amp;/g, '&') : ''
      });
    }
  }
  return designs;
}

function shuffleArray(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

function pickDesigns(allDesigns, tracker) {
  let remaining = tracker.remaining;
  if (!remaining || remaining.length === 0) {
    remaining = allDesigns.map(d => d.page_url);
    shuffleArray(remaining);
  }
  if (remaining.length < 5) {
    const usedUrls = new Set(remaining);
    const freshPool = allDesigns.map(d => d.page_url).filter(url => !usedUrls.has(url));
    shuffleArray(freshPool);
    remaining = remaining.concat(freshPool);
  }
  const selectedUrls = remaining.slice(0, 5);
  const newRemaining = remaining.slice(5);
  const selectedDesigns = selectedUrls.map(url => allDesigns.find(d => d.page_url === url));
  return {
    selected: selectedDesigns,
    newTracker: { remaining: newRemaining, last_updated: new Date().toISOString() }
  };
}

function pickRandomMusic() {
  const files = fs.readdirSync('music').filter(f => f.toLowerCase().endsWith('.mp3'));
  const chosen = files[Math.floor(Math.random() * files.length)];
  return `https://raw.githubusercontent.com/${GITHUB_USER}/${GITHUB_REPO}/${GITHUB_BRANCH}/music/${encodeURIComponent(chosen)}`;
}

function pickRandomDescription() {
  const descriptions = JSON.parse(fs.readFileSync('config/descriptions.json', 'utf8'));
  return descriptions[Math.floor(Math.random() * descriptions.length)];
}

function buildHashtags() {
  const data = JSON.parse(fs.readFileSync('config/hashtags.json', 'utf8'));
  const pool = [...data.pool];
  shuffleArray(pool);
  const randomFour = pool.slice(0, 4);
  return [...data.fixed, ...randomFour];
}

function withUtm(baseUrl, platform, content) {
  const url = new URL(baseUrl);
  url.searchParams.set('utm_source', platform);
  url.searchParams.set('utm_medium', 'organic_social');
  url.searchParams.set('utm_campaign', 'design_showcase');
  url.searchParams.set('utm_content', content);
  return url.toString();
}

function buildFullDescription(baseDescription, selectedDesigns, hashtags, platform) {
  const siteLink = withUtm(SITE_URL, platform, 'site_link');
  const designLinks = selectedDesigns
    .map((d, i) => withUtm(d.page_url, platform, `design_${i + 1}`))
    .join('\n');

  return [
    baseDescription,
    '',
    siteLink,
    designLinks,
    '',
    hashtags.join(' ')
  ].join('\n');
}

// ==== التشغيل ====
const xml = fs.readFileSync('data/sitemap-images.xml', 'utf8');
const allDesigns = parseSitemap(xml);

const tracker = JSON.parse(fs.readFileSync('data/design-tracker.json', 'utf8'));
const result = pickDesigns(allDesigns, tracker);

const musicUrl = pickRandomMusic();
const description = pickRandomDescription();
const hashtags = buildHashtags();

const description_facebook = buildFullDescription(description, result.selected, hashtags, 'facebook');
const description_tiktok = buildFullDescription(description, result.selected, hashtags, 'tiktok');

fs.writeFileSync('data/design-tracker.json', JSON.stringify(result.newTracker, null, 2));

const finalOutput = {
  images: result.selected.map(d => d.image_url),
  music_url: musicUrl,
  description_facebook,
  description_tiktok
};

fs.writeFileSync('data/latest-output.json', JSON.stringify(finalOutput, null, 2));

console.log('===== FACEBOOK DESCRIPTION =====');
console.log(description_facebook);
console.log('\n===== TIKTOK DESCRIPTION =====');
console.log(description_tiktok);
console.log('\n===== IMAGES =====');
console.log(finalOutput.images.join('\n'));
console.log('\n===== MUSIC =====');
console.log(musicUrl);
console.log(`\n📦 تبقى بالمخزون: ${result.newTracker.remaining.length} تصميم`);
