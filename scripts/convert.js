
const path = require('path');
const fs = require('fs');
const inputHtml = path.resolve(__dirname + '/../md/markdown-input.md');

const htmlin = String(fs.readFileSync(inputHtml) || '');

let inPre = false;
let prev = [];
let results = [];

const splitted = htmlin.split(/<pre.*>/);
splitted.shift();

const justPost = splitted.join('').split('</pre>');
justPost.pop();

console.log(justPost);
console.log(justPost.length);




console.log(results.join(''));

