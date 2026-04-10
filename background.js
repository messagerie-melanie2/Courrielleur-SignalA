/**
 * Extension SignalA - Script de fond
 *
 * Gère deux actions :
 *   - "get_state"  : fournit à la popup les destinations et le messageId
 *   - "signaler"   : effectue le transfert et le marquage indésirable
 */

messenger.runtime.onMessage.addListener((msg, sender) => {

  /* -----------------------------------------------------------
   * get_state
   * Appelé par la popup au chargement. Retourne :
   *   { destinations: [{libelle, to}], messageId: number|null }
   * ----------------------------------------------------------- */
  if (msg.action === 'get_state') {
    // Retourne une Promise : Thunderbird attend la réponse → OK
    return (async () => {
      try {

        // Destinations depuis les préférences Thunderbird (Experiment API)
        const destinations = await messenger.signalaPrefs.getBtSpam();

        // sender.tab est null depuis un popup (limitation WebExtension documentée).
        // On itère tous les onglets actifs pour trouver celui qui affiche un message.
        let messageId = null;
        const activeTabs = await messenger.tabs.query({ active: true });

        for (const tab of activeTabs) {
          try {
            const result = await messenger.messageDisplay.getDisplayedMessages(tab.id);
            const list = Array.isArray(result) ? result : (result?.messages ?? []);
            if (list.length > 0) {
              messageId = list[0].id;
              break;
            }
          } catch (ex) { /* pas un onglet de lecture, on continue */ }
        }

        return { destinations, messageId };

      } catch (ex) {
        console.error("[SignalA] Erreur get_state :", ex);
        return { destinations: [], messageId: null, error: ex.message };
      }
    })();
  }


  /* -----------------------------------------------------------
   * signaler
   * Déclenché par le clic sur une destination dans la popup.
   * La popup se ferme avant la fin du traitement : on lance
   * le travail en tâche de fond SANS retourner de Promise au
   * système de messages (return undefined = pas de réponse attendue).
   * Cela évite l'erreur "Actor 'Conduits' destroyed before query
   * 'RuntimeMessage' was resolved".
   * ----------------------------------------------------------- */
  if (msg.action === 'signaler') {

    const { to, messageId } = msg;

    // IIFE async détachée : fire-and-forget, aucune Promise remontée
    (async () => {
      try {

        // Enregistre l'observateur AVANT d'ouvrir la fenêtre de composition
        await messenger.signalaPrefs.setupAutoSendForNextCompose();

        const msgDetails = await messenger.messages.get(messageId);

        await messenger.compose.beginForward(
          messageId,
          "forwardAsAttachment",
          { to, subject: msgDetails.subject }
        );

        // Classe le message original comme indésirable
        await messenger.messages.update(messageId, { junk: true });

      } catch (ex) {
        console.error("[SignalA] Erreur lors du signalement :", ex);
      }
    })();

    // Pas de return → undefined → le système de messages sait qu'il
    // n'y a pas de réponse asynchrone en attente.
    return;
  }

});
