const MAIN_URL = "https://akwam.it";
const parser = new DOMParser();

let currentMediaItem = null;
let currentStreams = [];

const searchInput = document.getElementById('searchInput');
const searchBtn = document.getElementById('searchBtn');
const statusDiv = document.getElementById('status');
const resultsList = document.getElementById('resultsList');
const streamSection = document.getElementById('streamSection');
const selectedTitle = document.getElementById('selectedTitle');
const qualityButtons = document.getElementById('qualityButtons');
const saveBtn = document.getElementById('saveBtn');
const savedList = document.getElementById('savedList');
const clearSavedBtn = document.getElementById('clearSavedBtn');

// Initialize
document.addEventListener('DOMContentLoaded', loadSavedMovies);
searchBtn.addEventListener('click', handleSearch);
saveBtn.addEventListener('click', handleSaveCurrentMedia);
clearSavedBtn.addEventListener('click', clearAllSaved);
searchInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') handleSearch();
});

async function handleSearch() {
  const query = searchInput.value.trim();
  if (!query) return;

  resetUI();
  statusDiv.textContent = "🔍 Searching Akwam...";

  try {
    const results = await searchAkwam(query);
    if (results.length === 0) {
      statusDiv.textContent = "❌ No results found.";
      return;
    }
    statusDiv.textContent = "";
    renderSearchResults(results);
  } catch (err) {
    statusDiv.textContent = `❌ Search error: ${err.message}`;
  }
}

async function searchAkwam(query) {
  const searchUrl = `${MAIN_URL}/search?q=${encodeURIComponent(query)}`;
  const res = await fetch(searchUrl);
  const html = await res.text();
  const doc = parser.parseFromString(html, 'text/html');

  const results = [];
  doc.querySelectorAll('div.col-lg-auto, div.col-md-4, div.col-6').forEach((el) => {
    const box = el.querySelector('a.box');
    if (!box) return;
    const url = box.getAttribute('href');
    if (!url || url.includes('/games/') || url.includes('/programs/')) return;

    const poster = el.querySelector('picture > img');
    const title = poster?.getAttribute('alt') || el.querySelector('.entry-title')?.textContent.trim();
    const year = el.querySelector('.badge-secondary')?.textContent.trim() || '';

    if (title && url) {
      results.push({ title, url, year });
    }
  });
  return results;
}

function renderSearchResults(results) {
  resultsList.innerHTML = '';
  results.forEach(item => {
    const div = document.createElement('div');
    div.className = 'result-item';
    div.textContent = `${item.title} ${item.year ? `(${item.year})` : ''}`;
    div.onclick = () => selectMedia(item);
    resultsList.appendChild(div);
  });
}

async function selectMedia(item) {
  resultsList.innerHTML = '';
  currentMediaItem = item;
  selectedTitle.textContent = item.title;
  streamSection.classList.remove('hidden');
  qualityButtons.innerHTML = '';
  statusDiv.textContent = "🔗 Extracting MP4 stream nodes...";

  try {
    currentStreams = await extractAkwamLinks(item.url);
    statusDiv.textContent = "";

    if (currentStreams.length === 0) {
      statusDiv.textContent = "❌ No direct streams found.";
      return;
    }

    renderQualityButtons(currentStreams);
  } catch (err) {
    statusDiv.textContent = `❌ Extractor Error: ${err.message}`;
  }
}

async function extractAkwamLinks(watchUrl) {
  const res = await fetch(watchUrl);
  const html = await res.text();
  const doc = parser.parseFromString(html, 'text/html');

  const linksToResolve = [];

  doc.querySelectorAll('div.tab-content.quality').forEach((qualityTab) => {
    const qualityId = qualityTab.getAttribute('id') || '';
    
    qualityTab.querySelectorAll('.col-lg-6 > a').forEach((aTag) => {
      let href = aTag.getAttribute('href');
      const text = aTag.textContent;

      if (href) {
        if (!href.includes('/download/')) {
          const parts = href.split('/link');
          if (parts.length > 1) {
            const pathMatch = watchUrl.split(/\/movie|\/episode|\/shows|\/show\/episode/)[1] || '';
            href = `${MAIN_URL}/download${parts[1]}${pathMatch}`;
          }
        }
        
        linksToResolve.push({ 
          url: href, 
          qualityLabel: parseQualityLabel(qualityId, text)
        });
      }
    });
  });

  const finalStreams = [];
  for (const item of linksToResolve) {
    try {
      const linkRes = await fetch(item.url);
      const linkHtml = await linkRes.text();
      const linkDoc = parser.parseFromString(linkHtml, 'text/html');

      const finalUrl = linkDoc.querySelector('div.btn-loader > a')?.getAttribute('href') || 
                       linkDoc.querySelector('a.download-link')?.getAttribute('href');

      if (finalUrl) {
        finalStreams.push({ quality: item.qualityLabel, streamUrl: finalUrl });
      }
    } catch (err) {
      console.error("Node resolution failed", err);
    }
  }

  return finalStreams;
}

function parseQualityLabel(qualityId, rawText) {
  if (rawText.includes('1080')) return '1080p';
  if (rawText.includes('720')) return '720p';
  if (rawText.includes('480')) return '480p';
  if (rawText.includes('4K') || rawText.includes('2160')) return '4K';
  if (qualityId.includes('5')) return '1080p';
  if (qualityId.includes('4')) return '720p';
  if (qualityId.includes('3')) return '480p';
  return qualityId || 'Play';
}

function renderQualityButtons(streams) {
  qualityButtons.innerHTML = '';
  streams.forEach(stream => {
    const btn = document.createElement('button');
    btn.className = 'quality-btn';
    btn.textContent = `▶ Play ${stream.quality}`;
    
    btn.onclick = async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      
      if (!tab) {
        statusDiv.textContent = "⚠️ No active tab detected.";
        return;
      }

      chrome.tabs.sendMessage(tab.id, {
        action: "INJECT_STREAM",
        streamUrl: stream.streamUrl,
        quality: stream.quality
      }, (response) => {
        if (chrome.runtime.lastError || !response || response.status !== "success") {
          statusDiv.textContent = "⚠️ Please REFRESH your Vidora webpage tab and try again!";
        } else {
          statusDiv.textContent = `✅ Playing ${stream.quality} on Vidora!`;
        }
      });
    };

    qualityButtons.appendChild(btn);
  });
}

// Storage / Saved Movies Logic
async function handleSaveCurrentMedia() {
  if (!currentMediaItem || currentStreams.length === 0) return;

  const { savedMovies = [] } = await chrome.storage.local.get('savedMovies');
  const exists = savedMovies.some(m => m.url === currentMediaItem.url);

  if (!exists) {
    savedMovies.unshift({
      title: currentMediaItem.title,
      url: currentMediaItem.url,
      year: currentMediaItem.year,
      streams: currentStreams,
      savedAt: Date.now()
    });
    await chrome.storage.local.set({ savedMovies });
    saveBtn.textContent = "✅ Saved";
    loadSavedMovies();
  } else {
    saveBtn.textContent = "Already Saved";
  }
}

async function loadSavedMovies() {
  const { savedMovies = [] } = await chrome.storage.local.get('savedMovies');
  savedList.innerHTML = '';

  if (savedMovies.length === 0) {
    savedList.innerHTML = '<div class="empty-saved">No saved movies yet.</div>';
    return;
  }

  savedMovies.forEach((item, index) => {
    const div = document.createElement('div');
    div.className = 'saved-item';
    div.innerHTML = `
      <div class="saved-info">
        <strong>${item.title}</strong> ${item.year ? `(${item.year})` : ''}
      </div>
      <div class="saved-actions">
        <button class="btn-play-saved">▶ Select</button>
        <button class="btn-del-saved">✕</button>
      </div>
    `;

    div.querySelector('.btn-play-saved').onclick = () => {
      currentMediaItem = { title: item.title, url: item.url, year: item.year };
      currentStreams = item.streams;
      selectedTitle.textContent = item.title;
      streamSection.classList.remove('hidden');
      renderQualityButtons(item.streams);
      statusDiv.textContent = `Loaded "${item.title}" from saved list.`;
    };

    div.querySelector('.btn-del-saved').onclick = async () => {
      savedMovies.splice(index, 1);
      await chrome.storage.local.set({ savedMovies });
      loadSavedMovies();
    };

    savedList.appendChild(div);
  });
}

async function clearAllSaved() {
  await chrome.storage.local.remove('savedMovies');
  loadSavedMovies();
}

function resetUI() {
  statusDiv.textContent = "";
  resultsList.innerHTML = "";
  streamSection.classList.add('hidden');
  qualityButtons.innerHTML = "";
  saveBtn.textContent = "⭐ Save";
}