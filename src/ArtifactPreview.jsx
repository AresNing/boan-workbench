import { t as tr, localeTag } from './i18n.mjs';
import React, { useEffect, useState } from 'react';

// Render a conservative Markdown subset as React nodes. Raw HTML, remote images
// and executable links remain text, never injected into the application document.
const inline = text => text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part,i)=>part.startsWith('**') ? <strong key={i}>{part.slice(2,-2)}</strong> : part.startsWith('`') ? <code key={i}>{part.slice(1,-1)}</code> : part);
function Markdown({ content }) {
  const lines=content.split('\n'),blocks=[];
  const cells=line=>line.trim().replace(/^\||\|$/g,'').split('|').map(c=>c.trim());
  for(let i=0;i<lines.length;i++) {
    const line=lines[i],key=i;
    if(line.startsWith('```')) {const code=[];while(++i<lines.length && !lines[i].startsWith('```'))code.push(lines[i]);blocks.push(<pre key={key}><code>{code.join('\n')}</code></pre>);continue;}
    if(line.includes('|') && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[i+1] || '')) {
      const headers=cells(line),rows=[];i++;
      while(i+1<lines.length && lines[i+1].includes('|'))rows.push(cells(lines[++i]));
      blocks.push(<div className="markdown-table" key={key}><table><thead><tr>{headers.map((c,j)=><th key={j}>{inline(c)}</th>)}</tr></thead><tbody>{rows.map((r,j)=><tr key={j}>{headers.map((_,k)=><td key={k}>{inline(r[k] || '')}</td>)}</tr>)}</tbody></table></div>);continue;
    }
    const heading=line.match(/^(#{1,6})\s+(.+)/);
    if(heading){const Tag=`h${Math.min(heading[1].length+1,6)}`;blocks.push(<Tag key={key}>{inline(heading[2])}</Tag>);continue;}
    const list=line.match(/^\s*([-*+]|\d+[.)])\s+(.+)/);
    if(list){const ordered=/^\d/.test(list[1]),Tag=ordered?'ol':'ul',items=[list[2]],pattern=ordered?/^\s*\d+[.)]\s+(.+)/:/^\s*[-*+]\s+(.+)/;let next;
      while((next=lines[i+1]?.match(pattern))){i++;items.push(next[1]);}
      blocks.push(<Tag key={key}>{items.map((item,j)=><li key={j}>{inline(item)}</li>)}</Tag>);continue;}
    if(line)blocks.push(<p key={key}>{inline(line)}</p>);
  }
  return <div className="markdown-preview">{blocks}</div>;
}
export function ArtifactPreview({ file, taskId, api }) {
  const [data, setData] = useState(null), [error, setError] = useState(''), [source, setSource] = useState(false), [changes, setChanges] = useState(false);
  useEffect(() => {
    let live = true; setData(null); setError(''); setSource(false); setChanges(false);
    api(`/api/artifact?taskId=${encodeURIComponent(taskId)}&path=${encodeURIComponent(file)}`).then(value => { if (live) setData(value); }).catch(e => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [file, taskId]);
  if (error) return <p className="error-banner" role="alert">{error}</p>;
  if (!data) return <p role="status">{tr("正在读取成果…")}</p>;
  const image = data.mime?.startsWith('image/'), markdown = /\.md(?:own)?$/i.test(file), diff = /\.(diff|patch)$/i.test(file);
  // SVG is loaded only as an image: browser image mode disables scripts and
  // external resources. Never embed artifact HTML or SVG into the DOM.
  const url = image ? `data:${data.mime};base64,${data.base64 || btoa(unescape(encodeURIComponent(data.content)))}` : null;
  return <section className="artifact-preview" aria-label={tr("成果预览：{0}", file)}>
    <div className="artifact-toolbar"><span className="file-path">{file}</span>{data.change?.diff && <button type="button" onClick={()=>setChanges(!changes)}>{changes ? tr("查看文件") : tr("查看变更")}</button>}{!changes && (markdown || data.mime === 'image/svg+xml') && <button type="button" onClick={() => setSource(!source)}>{source ? tr("预览") : tr("查看源码")}</button>}</div>
    {data.change?.stale && <p className="muted">{tr("文件在交付后已变化，变更对比暂不可用。")}</p>}
    {changes || diff ? <pre className="diff-preview">{(changes ? data.change.diff : data.content).split('\n').map((line, i) => <span key={i} className={line.startsWith('+') ? 'diff-added' : line.startsWith('-') ? 'diff-removed' : ''}>{line}{'\n'}</span>)}</pre> : image && !source ? <img className="artifact-image" src={url} alt={file}/> : markdown && !source ? <Markdown content={data.content}/> : <pre>{data.content}</pre>}
  </section>;
}
