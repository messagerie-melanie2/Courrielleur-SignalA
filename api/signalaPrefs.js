"use strict";

/**
 * Experiment API - signalaPrefs
 *
 * Donne accès aux préférences Thunderbird natives (Services.prefs)
 * et à l'envoi silencieux de messages via observateur de fenêtre.
 */

var { ExtensionCommon } = ChromeUtils.importESModule("resource://gre/modules/ExtensionCommon.sys.mjs");
// Services et Components sont disponibles comme globaux dans les contextes privilégiés (Thunderbird 103+)

this.signalaPrefs = class extends ExtensionCommon.ExtensionAPI {

  getAPI(context) {
    return {
      signalaPrefs: {

        /* -------------------------------------------------------
         * getBtSpam()
         * Lit les préférences signala.btspam.* poussées par Pacome
         * ------------------------------------------------------- */
        async getBtSpam() {

          const destinations = [];

          for (let i = 0; i < 2; i++) {

            const prefTo = "courrielleur.btspam." + i + ".to";
            const prefLib = "courrielleur.btspam." + i + ".libelle";

            if (!Services.prefs.prefHasUserValue(prefTo)) continue;

            const to = Services.prefs.getCharPref(prefTo);
            if (!to) continue;

            const libelle = Services.prefs.prefHasUserValue(prefLib)
              ? Services.prefs.getStringPref(prefLib)
              : to;

            destinations.push({ libelle, to });
          }

          return destinations;
        },


        /* -------------------------------------------------------
         * setupAutoSendForNextCompose()
         *
         * Enregistre un observateur de fenêtre (Services.ww) qui
         * déclenche l'envoi automatique dès que la prochaine fenêtre
         * de composition Thunderbird est chargée.
         *
         * Se désenregistre automatiquement :
         *   - après l'envoi réussi
         *   - ou après 10 secondes (timeout de sécurité)
         *
         * Utilisation : appeler AVANT messenger.compose.beginForward()
         * depuis le background script.
         * ------------------------------------------------------- */
        async setupAutoSendForNextCompose() {

          const { setTimeout, clearTimeout } =
            ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");
          let timeoutId;
          let done = false;

          function cleanup() {
            if (done) return;
            done = true;
            clearTimeout(timeoutId);
            try { Services.ww.unregisterNotification(observer); } catch (ex) { }
          }

          function doSend(win) {
            cleanup();

            // Tentatives d'envoi par ordre de préférence
            let sent = false;

            // 1. cmd_sendNow via le dispatcher de commandes
            try {
              win.goDoCommand("cmd_sendNow");
              sent = true;
            } catch (ex) { }

            // 2. Fonction SendMessage() définie dans la fenêtre de composition
            if (!sent) {
              try {
                win.SendMessage();
                sent = true;
              } catch (ex) { }
            }

            if (!sent) {
              Components.utils.reportError(
                "[SignalA] Impossible de déclencher l'envoi automatique."
              );
            }
          }

          const observer = {

            QueryInterface: ChromeUtils.generateQI(["nsIObserver"]),

            observe(subject, topic /*, data */) {

              if (topic !== "domwindowopened") return;

              // subject est la fenêtre qui s'ouvre
              const win = subject;

              win.addEventListener("load", function onLoad() {
                win.removeEventListener("load", onLoad);

                // Vérifie que c'est bien une fenêtre de composition
                const winType = win.document?.documentElement
                  ?.getAttribute("windowtype") ?? "";

                const isCompose = winType === "msgcompose"
                  || win.location?.href?.includes("messengercompose");

                if (!isCompose) return;

                // Attend l'initialisation complète de la composition
                let sentViaCwi = false;

                win.addEventListener("compose-window-init", function onInit() {
                  win.removeEventListener("compose-window-init", onInit);
                  sentViaCwi = true;
                  doSend(win);
                }, { once: true });

                // Fallback : si compose-window-init ne se déclenche pas
                setTimeout(() => {
                  if (!sentViaCwi) doSend(win);
                }, 800);
              });
            }
          };

          Services.ww.registerNotification(observer);

          // Timeout de sécurité : 10 secondes maximum
          timeoutId = setTimeout(cleanup, 10_000);
        }

      }
    };
  }

};
