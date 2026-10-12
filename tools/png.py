import zlib,struct,sys
def load(path):
    d=open(path,'rb').read(); assert d[:8]==b'\x89PNG\r\n\x1a\n'
    p=8; idat=b''; w=h=0; ct=0; bd=8; plte=None
    while p<len(d):
        ln=struct.unpack('>I',d[p:p+4])[0]; t=d[p+4:p+8]; c=d[p+8:p+8+ln]; p+=12+ln
        if t==b'IHDR': w,h,bd,ct=struct.unpack('>IIBB',c[:10])
        elif t==b'PLTE': plte=c
        elif t==b'IDAT': idat+=c
    raw=zlib.decompress(idat)
    ch={0:1,2:3,3:1,4:2,6:4}[ct]; bpp=max(1,ch*bd//8); stride=(w*ch*bd+7)//8
    rows=[]; prev=bytearray(stride); q=0
    for y in range(h):
        f=raw[q]; q+=1; cur=bytearray(raw[q:q+stride]); q+=stride
        for i in range(stride):
            a=cur[i-bpp] if i>=bpp else 0; b=prev[i]; c=prev[i-bpp] if i>=bpp else 0
            if f==1: cur[i]=(cur[i]+a)&255
            elif f==2: cur[i]=(cur[i]+b)&255
            elif f==3: cur[i]=(cur[i]+(a+b)//2)&255
            elif f==4:
                pp=a+b-c; pa=abs(pp-a); pb=abs(pp-b); pc=abs(pp-c)
                cur[i]=(cur[i]+(a if pa<=pb and pa<=pc else b if pb<=pc else c))&255
        rows.append(bytes(cur)); prev=cur
    def px(x,y):
        r=rows[y]
        if ct==6: return tuple(r[x*4:x*4+4])
        if ct==2: return tuple(r[x*3:x*3+3])+(255,)
        if ct==0:
            if bd==8: v=r[x]; return (v,v,v,255)
            if bd==1: v=255 if (r[x//8]>>(7-x%8))&1 else 0; return (v,v,v,255)
        if ct==4: return (r[x*2],)*3+(r[x*2+1],)
        if ct==3:
            if bd==8: i=r[x]
            else: i=(r[x*bd//8]>>(8-bd-(x*bd)%8))&((1<<bd)-1)
            return tuple(plte[i*3:i*3+3])+(255,)
    return w,h,px
def ascii(path,x0,y0,x1,y1):
    w,h,px=load(path); out=[]
    for y in range(y0,min(y1,h)):
        s=''
        for x in range(x0,min(x1,w)):
            r,g,b,a=px(x,y)
            s+=' ' if a<128 else ('#' if r<128 else '.')
        out.append(f"{y:4d} {s}")
    return '\n'.join(out)
if __name__=='__main__':
    print(ascii(sys.argv[1],*map(int,sys.argv[2:6])))
