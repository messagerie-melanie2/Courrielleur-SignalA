experiment:
  on load:
    load smr_filter.js
    starts filter wrapper
    sends filterUseCount to background (via event)
    logs SMR version number 
  at init:  (from background.js, addresses (only if 'debug' changed))
    inject stylesheet, with
      redirect icon for redirected mails
    get width and height of screen
  redirect: (from addresses)
    removes data for vanished windows
    check for msg to send again (.sending=true)
    collect addresses
    get accountId
    get identity
    prepareMessage but at most maxconn


  abort: (from addresses, button 'cancel' or remove a message and already sending))

  onMailSent: event
  onFilterUseCount: event
    