const fs = require('fs');

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

// ==== التشغيل الفعلي (يقرأ من ملفات الريبو الحقيقية) ====
const xml = fs.readFileSync('data/sitemap-images.xml', 'utf8');
const allDesigns = parseSitemap(xml);
console.log(`✅ تم استخراج ${allDesigns.length} تصميم من sitemap`);

const tracker = JSON.parse(fs.readFileSync('data/design-tracker.json', 'utf8'));
const result = pickDesigns(allDesigns, tracker);

console.log('\n🎯 التصاميم المختارة:');
result.selected.forEach((d, i) => console.log(`${i + 1}. ${d.title} → ${d.image_url}`));
console.log(`\n📦 تبقى بالمخزون: ${result.newTracker.remaining.length} تصميم`);
