import re,os
root='app/src-tauri/src'
pat_fn=re.compile(r'^(pub(?:\([^)]*\))?\s+)?(async\s+)?fn\s+(\w+)', re.M)
viol=[]
for dp,_,fs in os.walk(root):
    for f in fs:
        if not f.endswith('.rs'): continue
        p=os.path.join(dp,f)
        src=open(p,encoding='utf-8').read()
        for m in pat_fn.finditer(src):
            b=src.find('{',m.end())
            if b<0: continue
            depth=0;end=len(src)
            for i in range(b,len(src)):
                if src[i]=='{':depth+=1
                elif src[i]=='}':
                    depth-=1
                    if depth==0: end=i;break
            body=src[b:end]
            g=re.search(r'\.grid\.(read|write)\(', body)
            gs=re.search(r'\.grids\.(read|write)\(', body)
            if g and gs and gs.start()<g.start():
                viol.append((p.replace(os.sep,'/'), m.group(3)))
for v in sorted(set(viol)): print(v[0], v[1])
print(len(set(viol)),'functions take grids before grid')
