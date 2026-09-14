(function(root){
  'use strict';
  const B=typeof module!=='undefined'?require('./model.js'):root.Biweekly;
  const M=typeof module!=='undefined'?require('./vendor/marked.js'):root.marked;
  function importMarkdown(source){
    const parsed={tasks:[],notes:''};
    function items(list){
      return list.items.map(item=>{
        let title=''; const note=[]; const children=[];
        for(const tok of item.tokens||[]){
          if(tok.type==='checkbox')continue;
          if(tok.type==='list')children.push(...items(tok));
          else if(!title&&(tok.type==='text'||tok.type==='paragraph'))title=tok.tokens?.[0]?.type==='checkbox'?tok.text.replace(/^\[[ xX]\]\s*/, ''):tok.text;
          else note.push(tok.raw||'');
        }
        title=title||item.text.split('\n')[0]||'未命名任务';
        const isDoing=/^\s*\[doing\]\s*/i.test(title);
        const isDone=/^\s*\[done\]\s*/i.test(title);
        title=title.replace(/^\s*\[(doing|done|todo)\]\s*/i,'').replace(/^~~([\s\S]*)~~$/,'$1');
        return B.task(title,item.checked||isDone?'done':isDoing?'doing':'todo',children,note.join('\n').trim());
      });
    }
    for(const token of M.lexer(source)){
      if(token.type==='list')parsed.tasks.push(...items(token));
      else parsed.notes+=token.raw||'';
    }
    parsed.notes=parsed.notes.trim();return parsed;
  }
  function exportMarkdown(c){
    let out=`# ${c.start} 双周\n\n`;
    if(c.notes)out+=c.notes+'\n\n';
    function lines(tasks,depth=0){
      for(const t of tasks){
        const indent='  '.repeat(depth);
        out+=`${indent}- [${t.status==='done'?'x':' '}] ${t.status==='doing'?'[doing] ':''}${t.title.replace(/\n/g,' ')}\n`;
        if(t.notes)out+='\n'+t.notes.split('\n').map(l=>indent+'  '+l).join('\n')+'\n\n';
        lines(t.children,depth+1);
      }
    }
    lines(c.tasks);return out;
  }
  const api={importMarkdown,exportMarkdown};
  if(typeof module!=='undefined')module.exports=api;else root.MarkdownIO=api;
})(globalThis);
