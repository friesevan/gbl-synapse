(function(root){
  'use strict';
  let database;
  function open(){
    if(!database)database=new Promise((resolve,reject)=>{
      const request=indexedDB.open('pvpoke-pro',1);
      request.onupgradeneeded=()=>request.result.createObjectStore('rankings',{keyPath:'id'});
      request.onsuccess=()=>resolve(request.result);
      request.onerror=()=>{database=null;reject(request.error);};
      request.onblocked=()=>{database=null;reject(new Error('Close other tabs to enable saved rankings.'));};
    });
    return database;
  }
  async function operation(mode,action){
    const db=await open();
    return new Promise((resolve,reject)=>{
      const transaction=db.transaction('rankings',mode),request=action(transaction.objectStore('rankings'));
      let result;request.onsuccess=()=>{result=request.result;};
      transaction.oncomplete=()=>resolve(result);
      transaction.onabort=()=>reject(transaction.error||request.error||new Error('Saving failed.'));
      transaction.onerror=()=>{};
    });
  }
  root.PvPProSaved={
    async list(){const records=await operation('readonly',store=>store.getAll());return records.map(({rankings,...metadata})=>metadata).sort((a,b)=>b.updatedAt-a.updatedAt);},
    get:id=>operation('readonly',store=>store.get(id)),
    put:record=>operation('readwrite',store=>store.put(record)),
    remove:id=>operation('readwrite',store=>store.delete(id))
  };
})(globalThis);
