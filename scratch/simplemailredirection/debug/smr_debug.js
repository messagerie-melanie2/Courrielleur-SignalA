/*
 * debug, caller must call 'debugInit(true|false|number, shortname)'
 */

let debugging=null;
let maxlevel=1;
let debugShortname=null;
let debugFilename=null;
let debugcache=new Map;

function debugInit(dodebug, shortname=null, filename=null) {
  if (typeof dodebug=='boolean') debugging=dodebug;
  else if (typeof dodebug=='number') { debugging=dodebug>0; maxlevel=dodebug; }
  else if (!shortname) debugging=false;
  if (shortname) debugShortname=shortname;
  if (typeof Services=='object') debugFilename=filename; //only in implementation
//if (debugShortname=='ABS') console.log('DEBUG:INIT: dodebug='+dodebug+'('+typeof dodebug+') debugging='+debugging+' maxlevel='+maxlevel+' file='+debugFilename);
}
function debug(txt, param) {
//if (debugShortname=='ABS') console.log('DEBUG: debugging='+debugging+' param='+param+' '+txt);
  let force=false;
  let level=1;
  if (typeof param == 'boolean') { force=param; }
  if (!force && typeof param != 'object' && debugging===false) return;

  if (typeof param == 'number') level=param;
  const e=typeof param == 'object'?param:new Error();     // an error
  let stack = e.stack.toString().split(/\r\n|\n/);
  let ln=stack[1].replace(/moz-extension:\/\/.*\/(.*:\d+):\d+/, '$1');	//getExternalFilename@file:///D:/sourcen/Mozilla/thunderbird/Extensions/AddressbooksSync_wee/abs_utils.js:1289:6
//file:///D:/sourcen/Mozilla/thunderbird/Extensions/CopySent2Current_wee/
  ln=ln.replace(/file:\/\/.*\/(.*:\d+):\d+/, '$1');
  if (!ln) ln='?';

  if (!debugShortname) {
    console.error('debugInit not called at '+ln);
    debugShortname='UNK';
  }


	if (debugFilename) {
//const { FileUtils } = ChromeUtils.importESModule("resource://gre/modules/FileUtils.sys.mjs");
    let d=new Date();
    let s=d.toLocaleString();
    let flags=0x10|0x08|0x02;
          // 0x02=PR_WRONLY, 0x10=PR_APPEND, 0x08=PR_CREATE_FILE
    try {
      let logFile=new FileUtils.File(PathUtils.join(PathUtils.tempDir, debugFilename+'.log'));
      let strm = Cc["@mozilla.org/network/file-output-stream;1"].
        createInstance(Ci.nsIFileOutputStream);
      let os = Cc["@mozilla.org/intl/converter-output-stream;1"].
        createInstance(Ci.nsIConverterOutputStream);
      strm.QueryInterface(Ci.nsIOutputStream);
      strm.QueryInterface(Ci.nsISeekableStream);
      strm.init( logFile, flags, 0x180, 0 );	//0600
      os.init(strm, 'UTF-8', 0, 0x0000);
      //if (?) os.writeString("\n");
      os.writeString(s+': '+ln+' '+txt+"\n");
      os.close();
    } catch(e) {
      console.error(debugFilename+'.log: File write: '+e);
    }
  }

  if (typeof param == 'object') {
    console.error(debugShortname+': '+ln+' '+txt);
  } else if (force) {
    console.log(debugShortname+': '+ln+' '+txt);
  } else if (debugging===true && level<=maxlevel) {
    if (debugcache && debugcache.size) {
      for (let [s, t] of debugcache)
        console.debug(debugShortname+': '+t);
      debugcache.clear();
    }
    console.debug(debugShortname+': '+ln+' '+txt);
  } else if (debugging===null) {
		let d=new Date();
		let s=d.toLocaleString();
//		debugcache.set(debugcache.size+(ex?':fail':'')+'-'+s, '(cached) '+ln+' '+txt);
		debugcache.set(debugcache.size+'-'+s, '(cached) '+ln+' '+txt);
  }
}
