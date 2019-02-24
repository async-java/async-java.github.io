
const path = require('path');
const fs = require('fs');
const inputHtml = path.resolve(__dirname + '/../md/html-from-md.html');

const htmlin = String(fs.readFileSync(inputHtml) || '');

let startPre = false;
let inPre = false;
let prev = [];
let results = [];

let i = -1;
for(let v of htmlin){
  
  i++;
  
  const joined = prev.join('');
  
  if(joined === '<pre ' || joined === '<pre>'){
    inPre = true;
  }
  
  if(startPre && htmlin.slice(i,i+6) === '</pre>'){
    if(!inPre){
      throw 'Missing opening pre tag.';
    }
    startPre = false;
    inPre = false;
  }
  
  if(startPre && v === '<'){
    results.push('&lt;')
  }
  else if(startPre && v === '>'){
    results.push('&gt;')
  }
  else{
    results.push(v)
  }
  
  if(inPre === true && v === '>'){
    startPre = true;
  }
  
  if(prev.length > 4){
    prev.shift();
  }
  
  prev.push(v);
  
  
}


console.log(results.join(''));

