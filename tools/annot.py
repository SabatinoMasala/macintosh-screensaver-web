import re,struct,json
data=open('thin.bin','rb').read()
BASE=0x100000000
def rd32(va): o=va-BASE; return struct.unpack('<I',data[o:o+4])[0]
def rd64(va): o=va-BASE; return struct.unpack('<Q',data[o:o+8])[0]
def cstr(va):
    o=va-BASE
    if o<0 or o>=len(data): return None
    e=data.find(b'\0',o,o+200)
    if e<0: return None
    s=data[o:e]
    try: t=s.decode('utf-8')
    except: return None
    if len(t)>=2 and all(32<=ord(c)<127 for c in t): return t
    return None
def f32(va): return struct.unpack('<f',struct.pack('<I',rd32(va)))[0]
def f64(va): return struct.unpack('<d',struct.pack('<Q',rd64(va)))[0]
# objc stubs: 32-byte entries in __TEXT,__objc_stubs 0x10001fe1c len 0x12a0
stubs={}
sb=0x1000210c0
for i in range(0xbe0//32):
    a=sb+i*32
    i0=rd32(a); i1=rd32(a+4)
    # adrp x1, imm
    immlo=(i0>>29)&3; immhi=(i0>>5)&0x7ffff; imm=((immhi<<2)|immlo)
    if imm&(1<<20): imm-=1<<21
    page=(a&~0xfff)+(imm<<12)
    off=((i1>>10)&0xfff)*8
    selref=page+off
    raw=rd64(selref)
    target=raw&0xffffffff
    if target<BASE: target+=BASE
    stubs[a]=cstr(target)
# auth stubs / symbol stubs already annotated by otool.
out=open('annot.txt','w')
funcs=[]; cur=None; adrp={}
for line in open('disasm.txt'):
    m=re.match(r'^([0-9a-f]{16})\t(.*)$',line.rstrip('\n'))
    if not m: continue
    addr=int(m.group(1),16); ins=m.group(2)
    note=''
    if ins.startswith('pacibsp') or cur is None:
        cur={'start':addr,'lines':[],'refs':[],'consts':[],'strs':[]}; funcs.append(cur); adrp={}
    mm=re.match(r'adrp\t(x\d+), -?\d+ ; (0x[0-9a-f]+)',ins)
    if mm: adrp[mm.group(1)]=int(mm.group(2),16)
    mm=re.match(r'(ldr|ldp)\t([sdq])(\d+), (?:[sdq]\d+, )?\[(x\d+)(?:, #(0x[0-9a-f]+))?\]',ins)
    if mm and mm.group(4) in adrp:
        va=adrp[mm.group(4)]+(int(mm.group(5),16) if mm.group(5) else 0)
        try:
            if mm.group(2)=='s': v=f32(va); note=f'; float {v:.6g}'
            elif mm.group(2)=='d': v=f64(va); note=f'; double {v:.6g}'
            else: v=[f32(va+4*k) for k in range(4)]; note='; float4 '+','.join(f'{x:.4g}' for x in v)
            cur['consts'].append(note[2:])
        except Exception as e: pass
    mm=re.match(r'add\t(x\d+), (x\d+), #(0x[0-9a-f]+)',ins)
    if mm and mm.group(2) in adrp:
        va=adrp[mm.group(2)]+int(mm.group(3),16); s=cstr(va)
        if s: note=f'; "{s}"'; cur['strs'].append(s)
        adrp[mm.group(1)]=va
    mm=re.match(r'ldr\t(x\d+), \[(x\d+)(?:, #(0x[0-9a-f]+))?\]',ins)
    if mm and mm.group(2) in adrp and 'ldr\tx' in ins:
        va=adrp[mm.group(2)]+(int(mm.group(3),16) if mm.group(3) else 0)
        # got/selref pointer -> try resolve name
        try:
            raw=rd64(va); t=raw&((1<<43)-1)
            if t<BASE: t+=BASE
            s=cstr(t)
            if s: note=f'; -> "{s}"'
        except: pass
    mm=re.match(r'fmov\t[sd]\d+, #(-?[0-9.]+)',ins)
    if mm: cur['consts'].append('imm '+mm.group(1))
    mm=re.match(r'bl?\t(0x[0-9a-f]+)(.*)',ins)
    if mm:
        t=int(mm.group(1),16)
        if t in stubs: note=f'; objc_msgSend${stubs[t]}'; cur['refs'].append(stubs[t])
        elif 'symbol stub for:' in mm.group(2): cur['refs'].append(mm.group(2).split('symbol stub for:')[1].strip())
        elif 'Objc message' in mm.group(2): cur['refs'].append('msgSendSuper')
        elif BASE+0x1ab0<=t<BASE+0x1fe1c: cur['refs'].append(f'sub_{t:x}')
        else: cur['refs'].append(f'ext_{t:x}')
    cur['lines'].append(addr)
    out.write(f"{addr:x}\t{ins}\t{note}\n")
out.close()
json.dump([{'start':f['start'],'end':f['lines'][-1],'n':len(f['lines']),'refs':f['refs'],'consts':f['consts'],'strs':f['strs']} for f in funcs],open('funcs.json','w'))
print('funcs',len(funcs),'stubs resolved',sum(1 for v in stubs.values() if v))
