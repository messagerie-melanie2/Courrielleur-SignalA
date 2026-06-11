"use strict";

/**
 * Experiment API - signalaPrefs
 *
 * Fournit :
 *   - getBtSpam()         : lecture des préférences de destination
 *   - redirectMessage()   : vraie redirection RFC 5321 sans fenêtre de composition
 *                           (clone du moteur de "Simple Mail Redirection")
 */

var { ExtensionCommon } = ChromeUtils.importESModule("resource://gre/modules/ExtensionCommon.sys.mjs");
var { MailServices } = ChromeUtils.importESModule("resource:///modules/MailServices.sys.mjs");

// Services, Cc, Ci, Components sont des globaux dans les contextes privilégiés Thunderbird 103+

this.signalaPrefs = class extends ExtensionCommon.ExtensionAPI {

  getAPI(context) {

    /* ===========================================================
     *  Constante longueur max d'en-tête MIME (RFC 2822)
     * =========================================================== */
    const MAX_HEADER_LENGTH = 16384;

    /* ===========================================================
     *  Helpers MIME (portés depuis Simple Mail Redirection)
     * =========================================================== */

    /**
     * Encode un en-tête MIME en Quoted-Printable si nécessaire,
     * en gérant les très longues lignes par découpage.
     */
    function encodeMimeHeader(header) {
      const fieldNameLen = header.indexOf(": ") + 2;
      const encodeValue = (val, offset) =>
        MailServices.mimeConverter.encodeMimePartIIStr_UTF8(
          val, true, offset, Ci.nsIMimeConverter.MIME_ENCODED_WORD_SIZE
        );

      if (header.length <= MAX_HEADER_LENGTH) {
        return (
          header.substring(0, fieldNameLen) +
          encodeValue(header.substring(fieldNameLen), fieldNameLen) +
          "\r\n"
        );
      }

      // Ligne trop longue : découpage par virgule
      const fieldName = header.substring(0, fieldNameLen);
      let splitHeader = "";
      while (header.length > MAX_HEADER_LENGTH - 2) {
        let splitPos = header.substring(0, MAX_HEADER_LENGTH - 2).lastIndexOf(",");
        if (splitPos === -1) splitPos = header.indexOf(",");
        let currentLine;
        if (splitPos === -1) {
          currentLine = header;
          header = "";
        } else {
          currentLine = header.substring(0, splitPos);
          header = fieldName + header.substring(
            header.charAt(splitPos + 1) === " " ? splitPos + 2 : splitPos + 1
          );
        }
        splitHeader +=
          currentLine.substring(0, fieldNameLen) +
          encodeValue(currentLine.substring(fieldNameLen), fieldNameLen) +
          "\r\n";
      }
      splitHeader +=
        header.substring(0, fieldNameLen) +
        encodeValue(header.substring(fieldNameLen), fieldNameLen) +
        "\r\n";
      return splitHeader;
    }

    /**
     * Génère la date RFC 2822 pour les en-têtes Resent-Date.
     */
    function getResentDate() {
      const date = new Date();
      const twoDigits = n => (n < 10 ? "0" + n : String(n));
      let offset = date.getTimezoneOffset();
      const sign   = offset <= 0 ? "+" : "-";
      offset = Math.abs(offset);
      const tzStr  = sign + twoDigits(Math.floor(offset / 60)) + twoDigits(offset % 60);
      return (
        date.toLocaleString("en-US", { weekday: "short" }) + ", " +
        date.toLocaleString("en-US", { day: "numeric" })   + " " +
        date.toLocaleString("en-US", { month: "short" })   + " " +
        date.toLocaleString("en-US", { year: "numeric" })  + " " +
        date.toLocaleTimeString("de-DE") + " " + tzStr
      );
    }

    /**
     * Construit le bloc d'en-têtes Resent-* à injecter en tête du message.
     * @param {nsIMsgCompFields} compFields
     * @param {nsIMsgIdentity}   identity
     * @returns {string}
     */
    function buildResentHeaders(compFields, identity) {
      let hdrs = "";
      hdrs += encodeMimeHeader("Resent-From: " + compFields.from);
      if (compFields.to)  hdrs += encodeMimeHeader("Resent-To: "  + compFields.to);
      if (compFields.cc)  hdrs += encodeMimeHeader("Resent-Cc: "  + compFields.cc);
      if (!compFields.to && !compFields.cc) {
        hdrs += encodeMimeHeader("Resent-To: undisclosed-recipients:;\r\n");
      }
      hdrs += "Resent-Date: " + getResentDate() + "\r\n";
      if (compFields.messageId) {
        hdrs += "Resent-Message-ID: " + compFields.messageId + "\r\n";
      }
      return hdrs;
    }

    /**
     * Crée un fichier temporaire unique.
     * Compatible TB < 116 (FileUtils.getFile) et TB >= 116 (FileUtils.File + PathUtils).
     * @returns {nsIFile}
     */
    function makeTmpFile() {
      const { FileUtils } = ChromeUtils.importESModule(
        "resource://gre/modules/FileUtils.sys.mjs"
      );
      let tmpFile;
      if (typeof FileUtils.getFile === "function") {
        // TB <= 115
        tmpFile = FileUtils.getFile("TmpD", ["signala_redirect.tmp"]);
      } else {
        // TB >= 116
        const m3p = Services.wm.getMostRecentWindow("mail:3pane");
        tmpFile = new FileUtils.File(
          m3p.PathUtils.join(m3p.PathUtils.tempDir, "signala_redirect.tmp")
        );
      }
      tmpFile.createUnique(tmpFile.NORMAL_FILE_TYPE, parseInt("0600", 8));
      return tmpFile;
    }

    /**
     * Copie le message identifié par son URI vers un fichier temporaire,
     * en préfixant les en-têtes Resent-* au début et en supprimant les
     * en-têtes sensibles (Return-Path, DKIM-Signature, etc.)
     *
     * @param {string}           msgUri
     * @param {nsIMsgCompFields} compFields
     * @param {nsIMsgIdentity}   identity
     * @returns {Promise<nsIFile>}
     */
    function buildResentFile(msgUri, compFields, identity) {
      return new Promise((resolve, reject) => {
        const tmpFile = makeTmpFile();

        const aScriptableInputStream = Cc["@mozilla.org/scriptableinputstream;1"]
          .createInstance(Ci.nsIScriptableInputStream);
        const aFileOutputStream = Cc["@mozilla.org/network/file-output-stream;1"]
          .createInstance(Ci.nsIFileOutputStream);

        try {
          aFileOutputStream.init(tmpFile, -1, parseInt("0600", 8), 0);
        } catch (e) {
          reject(new Error("[SignalA] Impossible de créer le fichier temporaire : " + e));
          return;
        }

        let inHeader  = true;
        let skipping  = false;
        let leftovers = "";
        let buf       = "";
        let lt        = "";    // line terminator (détecté sur premier appel)
        let lts       = 0;    // longueur du terminateur
        let inFrom    = false;
        let fromLines = "";    // accumule le From: complet (avec continuations)
        let replyTo   = "";
        let haveReplyTo = false;
        let resentHeadersWritten = false;

        /**
         * Écrit le From: accumulé (toutes les lignes de continuation incluses)
         * et construit le Reply-To à partir de celui-ci.
         */
        function flushFrom() {
          if (!fromLines) return;
          // Écriture du From: complet avec toutes ses lignes de continuation
          const fromOut = fromLines + "\r\n";
          aFileOutputStream.write(fromOut, fromOut.length);
          // Construit Reply-To à partir du From: complet
          replyTo = fromLines.replace(/^[Ff]rom:/, "Reply-To:");
          fromLines = "";
          inFrom = false;
        }

        const copyListener = {
          onStartRequest() {},

          onStopRequest(_req, _ctx, statusCode) {
            // Flush du From: en cours si les en-têtes se terminent brutalement
            flushFrom();
            // Écriture des résidus
            aFileOutputStream.write(leftovers, leftovers.length);
            aFileOutputStream.close();

            if (statusCode) {
              try { tmpFile.remove(false); } catch (_) {}
              reject(new Error("[SignalA] Copie du message échouée (status " + statusCode + ")"));
              return;
            }
            if (tmpFile.fileSize === 0) {
              try { tmpFile.remove(false); } catch (_) {}
              reject(new Error("[SignalA] Le message source est vide."));
              return;
            }
            resolve(tmpFile);
          },

          onDataAvailable(_req, inputStream, _offset, count) {
            aScriptableInputStream.init(inputStream);
            buf = leftovers + aScriptableInputStream.read(count);

            // Détection du terminateur de ligne + écriture des en-têtes Resent-*
            if (!lt) {
              lt  = buf.indexOf("\r") === -1 ? "\n" : "\r\n";
              lts = lt.length;
              const resentHdrs = buildResentHeaders(compFields, identity);
              aFileOutputStream.write(resentHdrs, resentHdrs.length);
              resentHeadersWritten = true;
            }

            if (inHeader) {
              leftovers = "";

              while (buf.length > 0) {
                // Cherche la fin de la ligne courante
                let eol = buf.indexOf("\r");
                if (eol === -1) eol = buf.indexOf("\n");

                if (eol === -1) {
                  leftovers = buf;
                  break;
                }
                if (lts === 2 && eol + 1 < buf.length) {
                  eol++;  // avance sur \n
                } else if (lts === 2) {
                  leftovers = buf;
                  break;
                }

                const line = buf.substring(0, eol + 1 - lts);
                buf = buf.substring(eol + 1);

                // Fin des en-têtes
                if (line === "") {
                  // Écrit le From: accumulé s'il y en a un en cours
                  flushFrom();
                  if (!haveReplyTo && replyTo) {
                    aFileOutputStream.write(replyTo + "\r\n", replyTo.length + 2);
                  }
                  aFileOutputStream.write("\r\n", 2);
                  inHeader = false;
                  leftovers = buf;
                  break;
                }

                // Gestion des continuations multi-lignes de "From:"
                if (inFrom) {
                  if (line[0] === " " || line[0] === "\t") {
                    // Continuation du From: → on accumule
                    fromLines += "\r\n" + line;
                    continue;
                  } else {
                    // Fin du From: multi-ligne → on flush
                    flushFrom();
                  }
                }

                // Gestion des continuations de lignes à supprimer
                if (skipping) {
                  if (line[0] === " " || line[0] === "\t") continue;
                  else skipping = false;
                }

                // Détecte le début d'un From:
                if (/^from: /i.test(line)) {
                  // Ne pas écrire tout de suite : on accumule pour
                  // capturer les éventuelles lignes de continuation
                  fromLines = line;
                  inFrom = true;
                  continue;   // on n'écrit pas encore, on attend les continuations
                }
                if (/^reply-to: /i.test(line)) {
                  haveReplyTo = true;
                }

                // Suppression des en-têtes sensibles / internes
                if (
                  /^[>]*From \S+ /.test(line)              ||
                  /^bcc: /i.test(line)                     ||
                  /^resent-bcc: /i.test(line)              ||
                  /^fcc: /i.test(line)                     ||
                  /^content-length: /i.test(line)          ||
                  /^lines: /i.test(line)                   ||
                  /^status: /i.test(line)                  ||
                  /^x-mozilla-status(?:2)?: /i.test(line)  ||
                  /^x-mozilla-draft-info: /i.test(line)    ||
                  /^x-mozilla-newshost: /i.test(line)      ||
                  /^x-uidl: /i.test(line)                  ||
                  /^x-vm-\S+: /i.test(line)                ||
                  /^return-path: /i.test(line)             ||
                  /^delivered-to: /i.test(line)            ||
                  /^dkim-signature: /i.test(line)          ||
                  /^x-identity-key: /i.test(line)          ||
                  /^x-account-key: /i.test(line)
                ) {
                  skipping = true;
                  continue;
                }

                // Écriture de la ligne conservée
                const lineOut = line + "\r\n";
                aFileOutputStream.write(lineOut, lineOut.length);
              }

            } else {
              // Corps du message : normalise les fins de ligne et écrit
              leftovers = "";
              buf = buf.replace(/\r\n|\n\r|\r|\n/g, "\r\n");
              aFileOutputStream.write(buf, buf.length);
              buf = "";
            }
          }
        };

        // Lance la copie du message
        const msgService = MailServices.messageServiceFromURI(msgUri);
        try {
          // TB < 114
          msgService.CopyMessage(msgUri, copyListener, false, null, null, {});
        } catch (_) {
          // TB >= 114
          msgService.copyMessage(msgUri, copyListener, false, null, null);
        }
      });
    }

    /* ===========================================================
     *  API publique
     * =========================================================== */
    return {
      signalaPrefs: {

        /* -------------------------------------------------------
         * getBtSpam()
         * Lit les préférences signala.btspam.* poussées par Pacome
         * ------------------------------------------------------- */
        async getBtSpam() {
          const destinations = [];
          for (let i = 0; i < 2; i++) {
            const prefTo  = "courrielleur.btspam." + i + ".to";
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
         * redirectMessage(messageId, toAddress)
         *
         * Effectue une vraie redirection RFC 5321 :
         *   1. Résout le msgHdr et l'identité de l'expéditeur.
         *   2. Crée des nsIMsgCompFields avec le destinataire admin.
         *   3. Copie le message original dans un fichier temporaire
         *      en injectant les en-têtes Resent-* au début.
         *   4. Envoie le fichier via nsIMsgSend.sendMessageFile().
         *
         * Aucune fenêtre de composition n'est ouverte.
         * L'enveloppe SMTP utilise l'identité de l'agent connecté
         * (évite les rejets SPF/DKIM).
         * ------------------------------------------------------- */
        async redirectMessage(messageId, toAddress) {

          // 1. Récupère le msgHdr
          const msgHdr = context.extension.messageManager.get(messageId);
          if (!msgHdr) {
            throw new Error(`[SignalA] Message introuvable : id=${messageId}`);
          }

          // 2. Résout l'identité et la clé de compte
          let identity;
          let accountKey;
          try {
            const account = MailServices.accounts.getAccount(msgHdr.folder.server.key);
            identity   = account?.defaultIdentity;
            accountKey = account?.key;
          } catch (_) {}
          if (!identity) {
            identity   = MailServices.accounts.defaultAccount?.defaultIdentity;
            accountKey = MailServices.accounts.defaultAccount?.key;
          }
          if (!identity) {
            throw new Error("[SignalA] Impossible de résoudre l'identité de l'expéditeur.");
          }

          const msgURI = msgHdr.folder.getUriForMsg(msgHdr);

          // 3. Crée les champs de composition
          const compFields = Cc["@mozilla.org/messengercompose/composefields;1"]
            .createInstance(Ci.nsIMsgCompFields);

          compFields.to   = toAddress;
          compFields.from = MailServices.headerParser.makeMimeHeader(
            [{ name: identity.fullName, email: identity.email }], 1
          );
          compFields.fcc  = identity.fccFolder || "nocopy://";
          compFields.fcc2 = "";

          // Génère un nouveau Message-ID
          try {
            // TB >= 115.5
            compFields.messageId = Cc["@mozilla.org/messengercompose/computils;1"]
              .createInstance(Ci.nsIMsgCompUtils)
              .msgGenerateMessageId(identity, null);
          } catch (_) {
            try {
              // TB 91-115
              compFields.messageId = Cc["@mozilla.org/messengercompose/computils;1"]
                .createInstance(Ci.nsIMsgCompUtils)
                .msgGenerateMessageIdFromIdentity(identity);
            } catch (_2) {
              compFields.messageId = "";
            }
          }

          // 4. Construit le fichier temporaire avec en-têtes Resent-*
          console.log("[SignalA] Début de la copie du message pour redirection...");
          const tmpFile = await buildResentFile(msgURI, compFields, identity);
          console.log("[SignalA] Fichier temporaire prêt :", tmpFile.path);

          // 5. Envoie via SMTP
          return new Promise((resolve, reject) => {
            const sendListener = {
              QueryInterface: ChromeUtils.generateQI([
                "nsIMsgSendListener",
                "nsIMsgCopyServiceListener",
              ]),
              onStartSending()  { console.log("[SignalA] Envoi SMTP démarré."); },
              onProgress()      {},
              onStatus()        {},
              onSendNotPerformed() {},
              onTransportSecurityError() {},
              onGetDraftFolderURI() {},
              onStopSending(msgId, status) {
                try { tmpFile.remove(false); } catch (_) {}
                if (status) {
                  const err = new Error("[SignalA] Échec envoi SMTP (status 0x" + status.toString(16) + ")");
                  console.error(err.message);
                  reject(err);
                } else {
                  console.log("[SignalA] Redirection envoyée avec succès !");
                  resolve();
                }
              },
            };

            const msgSend = Cc["@mozilla.org/messengercompose/send;1"]
              .createInstance(Ci.nsIMsgSend);

            msgSend.sendMessageFile(
              identity,           // nsIMsgIdentity       aUserIdentity
              accountKey,         // string               accountKey
              compFields,         // nsIMsgCompFields     fields
              tmpFile,            // nsIFile              sendIFile
              true,               // PRBool               deleteSendFileOnCompletion
              false,              // PRBool               digest_p
              msgSend.nsMsgDeliverNow, // nsMsgDeliverMode mode
              null,               // nsIMsgDBHdr          msgToReplace
              sendListener,       // nsIMsgSendListener   aListener
              null,               // nsIMsgStatusFeedback aStatusFeedback
              ""                  // string               password
            );
          });
        },

      }
    };
  }

};
