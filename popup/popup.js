/**
 * Extension SignalA - Popup "Signaler"
 *
 * La popup délègue toute la logique au background script :
 *   - get_state  : obtient les destinations et le messageId
 *   - signaler   : déclenche le transfert et le marquage
 */

document.addEventListener('DOMContentLoaded', init);

/* ---- Initialisation ------------------------------------------------- */

async function init() {
  try {

    // Délègue au background qui a le bon contexte (sender.tab, Experiment API)
    const state = await messenger.runtime.sendMessage({ action: 'get_state' });

    if (state.error) {
      showInfo('Erreur de configuration : ' + state.error);
      return;
    }

    if (!state.destinations || state.destinations.length === 0) {
      showInfo('Aucun signalement n\'est configuré pour ce profil.');
      return;
    }

    if (!state.messageId) {
      showInfo('Aucun message sélectionné.');
      return;
    }

    renderDestinations(state.destinations, state.messageId);

  } catch (ex) {
    showInfo('Erreur d\'initialisation : ' + ex.message);
  }
}


/* ---- Rendu ---------------------------------------------------------- */

function renderDestinations(destinations, messageId) {

  showView('view-destinations');

  const list = document.getElementById('destinations-list');

  for (const dest of destinations) {
    const btn = document.createElement('button');
    btn.className = 'dest-btn';
    btn.dataset.libelle = dest.libelle || dest.to;

    // Label + adresse
    const spanLabel = document.createElement('span');
    spanLabel.className = 'btn-label';
    spanLabel.textContent = dest.libelle || dest.to;

    const spanAddr = document.createElement('span');
    spanAddr.className = 'btn-addr';
    spanAddr.textContent = dest.to;

    btn.appendChild(spanLabel);
    btn.appendChild(spanAddr);

    btn.addEventListener('click', () => doSignaler(dest.to, messageId, btn));
    list.appendChild(btn);
  }
}


/* ---- Action de signalement ------------------------------------------ */

async function doSignaler(adminAddress, messageId, clickedBtn) {

  // Désactive tous les boutons pendant l'envoi
  document.querySelectorAll('.dest-btn').forEach(b => b.disabled = true);

  // Indicateur de progression
  clickedBtn.innerHTML = '<span class="spinner"></span>Envoi en cours…';

  // Fire-and-forget : on n'attend pas la réponse du background
  // (la popup serait détruite avant que beginForward se termine)
  messenger.runtime.sendMessage({
    action: 'signaler',
    to: adminAddress,
    messageId: messageId
  }).catch(() => { }); // ignore l'erreur de contexte détruit

  // Feedback immédiat, puis fermeture
  showStatus('success', 'La fenêtre de rédaction va s\'ouvrir.\nVeuillez envoyer le message pré-rempli.');
  setTimeout(() => window.close(), 2500);
}


/* ---- Helpers de vue ------------------------------------------------- */

function showView(id) {
  ['view-loading', 'view-destinations', 'view-info', 'view-status'].forEach(v => {
    const el = document.getElementById(v);
    if (el) el.style.display = (v === id) ? '' : 'none';
  });
}

function showInfo(text, type) {
  const el = document.getElementById('view-info');
  el.textContent = text;
  if (type === 'warning') {
    // Réutilise le style status-box pour le warning
    el.className = 'view status-box warning';
  } else {
    el.className = 'view info';
  }
  showView('view-info');
}

function showStatus(type, text) {
  const el = document.getElementById('view-status');
  el.innerHTML = '';
  const box = document.createElement('div');
  box.className = 'status-box ' + type;
  box.textContent = text;
  el.appendChild(box);
  showView('view-status');
}
