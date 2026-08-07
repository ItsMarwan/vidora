chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "INJECT_STREAM") {
    const success = replaceVidoraPlayer(request.streamUrl, request.quality);
    sendResponse({ status: success ? "success" : "failed" });
  }
  return true;
});

function replaceVidoraPlayer(streamUrl, quality) {
  // Finds iframe or Vidora main app container
  const iframe = document.querySelector('iframe');
  const appContainer = document.querySelector('#app') || document.querySelector('main');

  const videoPlayer = document.createElement('video');
  videoPlayer.id = 'vidora-native-player';
  videoPlayer.controls = true;
  videoPlayer.autoplay = true;
  videoPlayer.style.width = '100%';
  videoPlayer.style.height = '100%';
  videoPlayer.style.minHeight = '480px';
  videoPlayer.style.maxHeight = '80vh';
  videoPlayer.style.backgroundColor = '#000';
  videoPlayer.style.borderRadius = '12px';

  const source = document.createElement('source');
  source.src = streamUrl;
  source.type = 'video/mp4';
  videoPlayer.appendChild(source);

  if (iframe) {
    iframe.parentNode.replaceChild(videoPlayer, iframe);
  } else if (appContainer) {
    appContainer.prepend(videoPlayer);
  } else {
    return false;
  }

  console.log(`[Vidora Helper] Stream injected (${quality}): ${streamUrl}`);
  return true;
}