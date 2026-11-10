const fs = require('fs');

const GITHUB_USER = 'masterdxfcom-stack';
const GITHUB_REPO = 'masterdxf-social-publisher';
const GITHUB_BRANCH = 'main';
const SITE_URL = 'https://masterdxf.com';

// ==== قائمة الأصناف (sitemaps) ====
// تُقرأ من الملف config/sitemaps.txt — سطر لكل صنف، بالشكل:
//   الاسم | ملف الـ sitemap | ملف الهاشتاغات | ملف الأوصاف | ملف الـ tracker (اختياري)
// لإضافة صنف جديد: أضف سطراً واحداً هناك، ولا تلمس هذا الكود.
// في كل تشغيل يُستعمل صنف واحد (بالتناوب)، ويُؤخذ منه 5 تصاميم لبناء فيديو واحد.
const DESIGNS_PER_VIDEO = 5;
const SITEMAPS_LIST_FILE = 'config/sitemaps.txt';
const DEFAULT_HASHTAGS_FILE = 'config/hashtags.json';
const DEFAULT_DESCRIPTIONS_FILE = 'config/descriptions.json';
const ROTATION_FILE = 'data/sitemap-rotation.json';

function loadSitemapList() {
  const lines = fs.readFileSync(SITEMAPS_LIST_FILE, 'utf8').split(/\r?\n/);
  const list = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split('|').map(p => p.trim());
    const [name, file, hashtags, descriptions, tracker] = parts;
    if (!name || !file) { console.warn(`⚠️ سطر غير صالح في ${SITEMAPS_LIST_FILE}: ${line}`); continue; }
    list.push({
      name,
      file,
      hashtags: hashtags || DEFAULT_HASHTAGS_FILE,
      descriptions: descriptions || DEFAULT_DESCRIPTIONS_FILE,
      tracker: tracker || `data/trackers/${name}.json`
    });
  }
  if (list.length === 0) throw new Error(`لا يوجد أي صنف صالح في ${SITEMAPS_LIST_FILE}`);
  return list;
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { return fallback; }
}

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
  return arr;
}

function pickDesigns(allDesigns, tracker, count = DESIGNS_PER_VIDEO) {
  const known = new Map(allDesigns.map(d => [d.page_url, d]));
  const allUrls = [...known.keys()];

  // تنظيف الـ tracker من روابط لم تعد موجودة في الـ sitemap
  let remaining = (tracker.remaining || []).filter(u => known.has(u));
  let used = (tracker.used || []).filter(u => known.has(u));

  // تصاميم جديدة ظهرت في الـ sitemap: تُخلط وتوضع في المقدمة
  const seen = new Set([...remaining, ...used]);
  const fresh = allUrls.filter(u => !seen.has(u));
  remaining = [...shuffleArray(fresh), ...remaining];

  // انتهت الدورة: ابدأ دورة جديدة بترتيب مخلوط مختلف
  if (remaining.length === 0 && used.length > 0) {
    remaining = shuffleArray(used.slice());
    used = [];
  }

  const selected = remaining.slice(0, count);
  let newRemaining = remaining.slice(count);
  let newUsed = [...used, ...selected];

  // آخر الدورة وبقي أقل من 5: أكمل العدد من دورة جديدة مخلوطة (بلا تكرار داخل نفس الفيديو)
  if (selected.length < count && newUsed.length > selected.length) {
    const pool = shuffleArray(newUsed.filter(u => !selected.includes(u)));
    const need = Math.min(count - selected.length, pool.length);
    selected.push(...pool.slice(0, need));
    newRemaining = pool.slice(need);
    newUsed = selected.slice();
  }

  return {
    selected: selected.map(u => known.get(u)),
    newTracker: { remaining: newRemaining, used: newUsed, last_updated: new Date().toISOString() }
  };
}

function chooseSitemap(sitemaps) {
  const rotation = readJson(ROTATION_FILE, {});
  const n = sitemaps.length;
  // نبدأ من الصنف الذي يلي آخر صنف استُعمل (بالاسم، فإضافة أسطر جديدة لا تكسر الترتيب)
  const lastIdx = sitemaps.findIndex(sm => sm.name === rotation.last_sitemap);
  const startIdx = (lastIdx + 1) % n;
  for (let step = 0; step < n; step++) {
    const sm = sitemaps[(startIdx + step) % n];
    if (!fs.existsSync(sm.file)) { console.warn(`⚠️ الملف غير موجود: ${sm.file} — تخطّي ${sm.name}`); continue; }
    const designs = parseSitemap(fs.readFileSync(sm.file, 'utf8'));
    if (designs.length === 0) { console.warn(`⚠️ لا تصاميم صالحة في ${sm.file} — تخطّي ${sm.name}`); continue; }
    return { sm, designs };
  }
  throw new Error('لا يوجد أي sitemap صالح للقراءة');
}

function pickMusic(tracker) {
  const allFilenames = fs.readdirSync('music').filter(f => f.toLowerCase().endsWith('.mp3'));
  let remaining = tracker.remaining || [];
  let used = tracker.used || [];

  const knownFiles = new Set([...remaining, ...used]);
  const newFiles = allFilenames.filter(f => !knownFiles.has(f));
  if (newFiles.length > 0) {
    shuffleArray(newFiles);
    remaining = [...newFiles, ...remaining];
  }

  const currentFiles = new Set(allFilenames);
  remaining = remaining.filter(f => currentFiles.has(f));
  used = used.filter(f => currentFiles.has(f));

  if (remaining.length === 0 && used.length > 0) {
    remaining = used.slice();
    shuffleArray(remaining);
    used = [];
  }

  const selectedFile = remaining[0];
  const newRemaining = remaining.slice(1);
  const newUsed = [...used, selectedFile];

  const musicUrl = `https://raw.githubusercontent.com/${GITHUB_USER}/${GITHUB_REPO}/${GITHUB_BRANCH}/music/${encodeURIComponent(selectedFile)}`;

  return {
    url: musicUrl,
    newTracker: { remaining: newRemaining, used: newUsed }
  };
}

function loadWithFallback(file, fallbackFile, label) {
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  console.warn(`⚠️ ملف ${label} غير موجود: ${file} — استعمال الافتراضي ${fallbackFile}`);
  return JSON.parse(fs.readFileSync(fallbackFile, 'utf8'));
}

function pickRandomDescription(file) {
  const descriptions = loadWithFallback(file, DEFAULT_DESCRIPTIONS_FILE, 'الأوصاف');
  return descriptions[Math.floor(Math.random() * descriptions.length)];
}

function buildHashtags(hashtagData, fixedList, randomCount) {
  const pool = [...(hashtagData.pool || [])];
  shuffleArray(pool);
  return [...(fixedList || []), ...pool.slice(0, randomCount)];
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
  return [baseDescription, '', siteLink, designLinks, '', hashtags.join(' ')].join('\n');
}

// ==== التشغيل ====
const sitemaps = loadSitemapList();
const chosen = chooseSitemap(sitemaps);
const tracker = readJson(chosen.sm.tracker, {});
const result = pickDesigns(chosen.designs, tracker);
console.log(`🗺️ الصنف المستعمل: ${chosen.sm.name} (${chosen.designs.length} تصميم)`);

const musicTracker = JSON.parse(fs.readFileSync('data/music-tracker.json', 'utf8'));
const musicResult = pickMusic(musicTracker);
const musicUrl = musicResult.url;

// الوصف والهاشتاغات من ملفات الصنف نفسه
const description = pickRandomDescription(chosen.sm.descriptions);

const hashtagData = loadWithFallback(chosen.sm.hashtags, DEFAULT_HASHTAGS_FILE, 'الهاشتاغات');
const hashtagsFacebook = buildHashtags(hashtagData, hashtagData.fixed, 7);
const hashtagsTiktok = buildHashtags(hashtagData, hashtagData.fixed_tiktok, 2);

const description_facebook = buildFullDescription(description, result.selected, hashtagsFacebook, 'facebook');
const description_tiktok = buildFullDescription(description, result.selected, hashtagsTiktok, 'tiktok');
const description_instagram = buildFullDescription(description, result.selected, hashtagsFacebook, 'instagram');

fs.mkdirSync(require('path').dirname(chosen.sm.tracker), { recursive: true });
fs.writeFileSync(chosen.sm.tracker, JSON.stringify(result.newTracker, null, 2));
fs.writeFileSync(ROTATION_FILE, JSON.stringify({ last_sitemap: chosen.sm.name }, null, 2));
fs.writeFileSync('data/music-tracker.json', JSON.stringify(musicResult.newTracker, null, 2));

const finalOutput = {
  source_sitemap: chosen.sm.name,
  images: result.selected.map(d => d.image_url),
  music_url: musicUrl,
  hook_text: description,
  description_facebook,
  description_tiktok,
  description_instagram
};
fs.writeFileSync('data/latest-output.json', JSON.stringify(finalOutput, null, 2));

console.log('===== FACEBOOK DESCRIPTION =====');
console.log(description_facebook);
console.log('\n===== TIKTOK DESCRIPTION =====');
console.log(description_tiktok);
console.log('\n===== INSTAGRAM DESCRIPTION =====');
console.log(description_instagram);
console.log('\n===== IMAGES =====');
console.log(finalOutput.images.join('\n'));
console.log('\n===== MUSIC =====');
console.log(musicUrl);
console.log(`\n📦 designs remaining: ${result.newTracker.remaining.length} | used: ${result.newTracker.used.length}`);
console.log(`🎵 music remaining: ${musicResult.newTracker.remaining.length} | used: ${musicResult.newTracker.used.length}`);
