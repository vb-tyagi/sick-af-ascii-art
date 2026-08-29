import struct
d=open('runs/visual/fx-chromatic-default.png','rb').read()
print('size',len(d))
i=8
while i<len(d):
    ln=struct.unpack('>I',d[i:i+4])[0]
    typ=d[i+4:i+8].decode('latin1')
    extra=''
    if typ=='IHDR':
        w,h,bd,ct=struct.unpack('>IIBB',d[i+8:i+8+10])
        extra=f' w={w} h={h} bitdepth={bd} colortype={ct}'
    print(typ,ln,extra)
    if typ=='IEND': break
    i+=12+ln
