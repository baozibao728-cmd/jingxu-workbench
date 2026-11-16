// 动态背景：夜间是宇宙（星云、星空、行星、流星），白天是线描星轨，都会跟着鼠标动。
// 整段移植自「Claude 会话同步」面板。只画在 .sky 里的两块画布上，不碰业务逻辑。
// 浏览器没有 WebGL 时自动退回 2D 画布；系统开了“减少动态效果”时只画一帧静止画面。
(()=>{
const $=id=>document.getElementById(id);
if(!$('space')||!$('galaxy'))return;
const calm=matchMedia('(prefers-reduced-motion: reduce)').matches;
// 深色背景（GPU 着色器）：流体般的星云、三层视差星空、带大气层的行星、流星，鼠标附近有引力透镜般的扭曲
const SPACE=(()=>{
  const c=$('space'),gl=c&&c.getContext('webgl',{antialias:false,alpha:false,depth:false,powerPreference:'high-performance'});
  if(!gl)return {ok:false};
  const VS='attribute vec2 a;void main(){gl_Position=vec4(a,0.,1.);}';
  const FS=`precision highp float;
uniform vec2 uRes;uniform float uTime;uniform vec2 uMouse;uniform vec2 uPtr;uniform float uLens;uniform vec4 uMet;uniform float uGain;
uniform vec3 uSun;uniform vec4 uB[9];uniform vec4 uBc[9];uniform float uDay;
float h1(vec2 p){p=fract(p*vec2(123.34,456.21));p+=dot(p,p+45.32);return fract(p.x*p.y);}
float vn(vec2 p){vec2 i=floor(p),f=fract(p),u=f*f*(3.-2.*f);
  return mix(mix(h1(i),h1(i+vec2(1,0)),u.x),mix(h1(i+vec2(0,1)),h1(i+vec2(1,1)),u.x),u.y);}
float fbm(vec2 p){float v=0.,a=.5;mat2 r=mat2(.8,-.6,.6,.8);for(int i=0;i<6;i++){v+=a*vn(p);p=r*p*2.03+.17;a*=.5;}return v;}
float fbm4(vec2 p){float v=0.,a=.5;mat2 r=mat2(.8,-.6,.6,.8);for(int i=0;i<4;i++){v+=a*vn(p);p=r*p*2.03+.17;a*=.5;}return v;}
vec3 nebula(vec2 p){
  float t=uTime*.006;
  vec2 q=vec2(fbm(p*1.3+vec2(0.,t)),fbm(p*1.3+vec2(5.2,1.3)));
  vec2 r=vec2(fbm(p*1.3+3.2*q+vec2(1.7,9.2)+t),fbm(p*1.3+3.2*q+vec2(8.3,2.8)-t));
  float f=fbm(p*1.3+3.4*r);
  vec2 bn=normalize(vec2(.5,1.));
  float d=dot(p,bn)+.08*sin(p.x*2.3+1.)+.12*(r.x-.5);
  float band=exp(-d*d*5.5);
  float dens=smoothstep(.18,.9,f)*(.1+band*1.6);
  float hue=fbm4(p*.55+vec2(3.,7.));
  vec3 col=mix(vec3(.02,.04,.12),mix(vec3(.05,.22,.6),vec3(.36,.1,.48),smoothstep(.45,.62,hue)),clamp(f*f*2.2,0.,1.));
  col=mix(col,vec3(.62,.16,.45),clamp(dot(q,q)*1.2-.45,0.,1.)*.8);
  col=mix(col,vec3(.04,.48,.6),clamp(r.y*1.8-.66,0.,1.)*.85);
  col=mix(col,vec3(1.,.62,.32),pow(clamp(f*band*1.2,0.,1.),3.)*1.8);
  vec3 neb=col*dens*2.6;
  float dust=smoothstep(.48,.78,fbm4(p*3.4+r*2.2+7.));
  neb*=1.-dust*band*.82;
  return neb+vec3(.004,.008,.022)*(1.-band);
}
vec3 ring(vec3 col,vec2 p,vec4 B,vec3 c,float front){
  vec2 d=p-B.xy;float a=.35;vec2 q=vec2(cos(a)*d.x-sin(a)*d.y,sin(a)*d.x+cos(a)*d.y);q.y/=.3;
  float rr=length(q)/B.z;
  if(rr<1.3||rr>2.4)return col;
  if((q.y<0.?1.:0.)!=front)return col;
  float bands=.6+.4*sin(rr*40.)*(.5+.5*sin(rr*9.));
  float edge=smoothstep(1.3,1.42,rr)*smoothstep(2.4,2.22,rr)*(1.-.85*smoothstep(.05,0.,abs(rr-1.92)));
  vec2 toS=uSun.xy-B.xy;float lit=.45+.55*clamp(dot(normalize(d+1e-4),normalize(toS))*.5+.5,0.,1.);
  return mix(col,c*bands*lit*1.05,.8*edge);
}
vec3 starLayer(vec2 p,float sc,float prob,float size,float big,float seed,float band){
  vec2 g=p*sc+seed,id=floor(g),f=fract(g)-.5;
  float h=h1(id+seed);
  if(h>prob)return vec3(0.);
  vec2 o=(vec2(h1(id+1.7),h1(id+3.1))-.5)*.7;
  vec2 d=(f-o)/sc*uRes.y;
  float m=h/prob;
  float sz=size*(.6+m*m*m*big);
  float tw=.65+.35*sin(uTime*(1.2+h1(id+9.)*3.)+h*40.);
  float core=exp(-dot(d,d)/(sz*sz))*tw;
  float halo=sz*sz*.06/(dot(d,d)+sz*sz*2.)*tw;
  float spike=0.;
  if(m>.93){float k=sz*4.5;spike=(exp(-abs(d.y)*1.6)*exp(-abs(d.x)/k)+exp(-abs(d.x)*1.6)*exp(-abs(d.y)/k))*.55*tw;}
  float temp=h1(id+5.5);
  vec3 tint=temp<.18?vec3(1.,.78,.58):temp<.55?vec3(1.,.96,.92):vec3(.72,.84,1.);
  return tint*(core+halo+spike)*(.55+band);
}
void nightMain(){
  vec2 fc=gl_FragCoord.xy;
  vec2 p=(fc-.5*uRes)/uRes.y;
  float asp=uRes.x/uRes.y;
  vec2 dp=p-uPtr;float r2=dot(dp,dp);
  vec2 lens=-dp*uLens*.0011/(r2+.0016);
  vec2 cam=vec2(uTime*.0035,uTime*.0012);
  vec2 bn=normalize(vec2(.5,1.));
  vec2 pn=p+lens*.6+cam*.4+uMouse*.025;
  float bandD=dot(pn,bn);float band=exp(-bandD*bandD*5.5);
  vec3 col=nebula(pn)*uGain;
  col+=starLayer(p+lens*.8+cam*.55+uMouse*.035,150.,.12+band*.5,.5,.6,0.,band*.9)*(.35+band);
  col+=starLayer(p+lens+cam*.75+uMouse*.06,60.,.18+band*.2,.75,1.,11.,band*.5);
  col+=starLayer(p+lens*1.2+cam+uMouse*.1,18.,.16,1.05,2.2,23.,band*.2)*1.25;
  // 太阳：发亮的圆盘、日冕、横向光晕
  vec2 sd=p-uSun.xy;float sr=length(sd),R0=uSun.z;
  float sa=atan(sd.y,sd.x);
  float flare=.55+.45*fbm4(vec2(sa*2.5,uTime*.12+sr*6.));
  col+=vec3(1.,.6,.28)*R0*R0*1.1/(sr*sr+R0*R0*.35)*flare;
  col+=vec3(1.,.72,.42)*exp(-max(sr-R0,0.)/(R0*.9))*.9*flare;
  col+=vec3(1.,.82,.6)*exp(-abs(sd.y)*uRes.y*.1)*exp(-abs(sd.x)/(R0*6.))*.32;
  if(sr<R0*1.02){float mu=sqrt(max(1.-sr*sr/(R0*R0),0.));col=mix(col,vec3(1.,.9,.72)*(1.1+.9*mu),smoothstep(R0*1.02,R0*.97,sr));}
  // 行星：朝太阳的一面亮，会自转
  for(int i=0;i<9;i++){
    vec4 B=uB[i];vec4 BC=uBc[i];
    if(B.z<=0.)continue;
    float k=B.w;
    if(k>3.5)col=ring(col,p,B,BC.rgb,0.);
    vec2 d=(p-B.xy)/B.z;float l2=dot(d,d);
    if(l2<1.){
      vec3 n=vec3(d,sqrt(1.-l2));
      vec2 toS=uSun.xy-B.xy;vec3 L=normalize(vec3(toS,length(toS)*.3));
      float ndl=dot(n,L);
      float lon=atan(n.x,n.z)+uTime*(.04+BC.w*.06),lat=asin(clamp(n.y,-1.,1.));
      vec3 c=BC.rgb,sf;
      if(k<.5){sf=c*(.55+.6*fbm4(vec2(lon,lat)*3.+BC.w*10.));}
      else if(k<1.5){float land=smoothstep(.5,.56,fbm4(vec2(lon,lat)*2.2+BC.w*7.));
        sf=mix(vec3(.04,.18,.48),vec3(.22,.4,.18),land);
        float cl=smoothstep(.55,.75,fbm4(vec2(lon*1.4+uTime*.03,lat*3.)*2.+3.));sf=mix(sf,vec3(.95),cl*.85);}
      else{float bz=fbm4(vec2(lon*.8,lat*6.)+BC.w*5.);sf=c*(.62+.28*sin(lat*16.+bz*6.)+.3*bz);}
      vec3 pc=sf*(.02+1.25*max(ndl,0.));
      if(k>.5&&k<1.5||k>2.5&&k<3.5)pc+=vec3(.35,.62,1.)*pow(1.-n.z,4.)*smoothstep(-.2,.45,ndl)*.9;
      col=mix(col,pc,smoothstep(1.,1.-3./(B.z*uRes.y),l2));
    }
    if(k>3.5)col=ring(col,p,B,BC.rgb,1.);
  }
  // 流星
  if(uMet.w>0.){
    vec2 dir=vec2(cos(uMet.z),sin(uMet.z));float age=uMet.w;
    vec2 head=uMet.xy+dir*age*1.15;vec2 rel=p-head;
    float al=-dot(rel,dir),pe=abs(dot(rel,vec2(-dir.y,dir.x)))*uRes.y;
    float fade=sin(3.14159*clamp(age/.95,0.,1.));
    if(al>0.&&al<.3)col+=vec3(.75,.88,1.)*pow(1.-al/.3,2.)*exp(-pe*pe/1.6)*fade*1.4;
    float hd=length(rel)*uRes.y;col+=vec3(.8,.9,1.)*exp(-hd*hd/10.)*fade;
  }
  // 鼠标处一圈很淡的光环（透镜的爱因斯坦环）
  col+=vec3(.5,.7,1.)*exp(-pow((sqrt(r2)-.045)*90.,2.))*uLens*.05;
  // 暗角、色调映射、抖动去色带
  float vig=1.-.35*dot(p/vec2(asp,1.),p/vec2(asp,1.))*2.;
  col*=vig;
  col=1.-exp(-col*1.35);
  col=pow(col,vec3(.92));
  col+=(h1(fc+fract(uTime))-.5)/180.;
  gl_FragColor=vec4(col,1.);
}
void dayMain(){
  vec2 fc=gl_FragCoord.xy;
  vec2 p=(fc-.5*uRes)/uRes.y;
  float asp=uRes.x/uRes.y;
  vec3 INK=vec3(.078,.078,.075),CLAY=vec3(.851,.467,.341);
  vec2 cam=vec2(uTime*.002,uTime*.0008);
  vec2 pn=p+cam*.4+uMouse*.02;
  // 纸张
  vec3 col=vec3(.980,.976,.961)*(.988+.024*(vn(fc*.9)*.5+vn(fc*.31)*.5));
  // 水彩晕染：蜜桃、陶土、燕麦、淡紫
  float t=uTime*.005;
  vec2 q=vec2(fbm4(pn*.75+vec2(0.,t)),fbm4(pn*.75+vec2(5.2,1.3)));
  vec2 r=vec2(fbm4(pn*.75+1.8*q+vec2(1.7,9.2)+t),fbm4(pn*.75+1.8*q+vec2(8.3,2.8)-t));
  float f=fbm(pn*.75+2.*r);
  float hue=fbm4(pn*.5+vec2(3.,7.));
  float big=fbm4(p*.55+vec2(t*.6,2.));
  col=mix(col,col*vec3(.95,.83,.74),smoothstep(.38,.68,big)*.75);
  col=mix(col,col*vec3(.88,.87,.95),smoothstep(.55,.78,fbm4(p*.5+vec2(9.,t)))*.6);
  vec3 pig=mix(vec3(.94,.72,.58),vec3(.84,.82,.92),smoothstep(.56,.7,hue)*.6);
  pig=mix(pig,vec3(.9,.55,.4),smoothstep(.58,.8,f)*.6);
  pig=mix(pig,vec3(.93,.9,.82),clamp(r.y*1.5-.7,0.,1.)*.5);
  float dens=smoothstep(.27,.62,f);
  float pool=smoothstep(.03,0.,abs(f-.52))*step(.45,f);
  float wash=clamp((dens*1.05+pool*.35)*(uGain+.25)*(.82+.3*vn(fc*.45)),0.,1.);
  col=mix(col,col*pig,wash*.95);
  // 墨点星星和陶土色小星芒
  float s1=dot(starLayer(pn*1.+uMouse*.03,90.,.1,.55,.4,3.,0.),vec3(.33));
  float s2=dot(starLayer(pn*1.+uMouse*.07,16.,.12,.9,1.6,29.,0.),vec3(.33));
  col=mix(col,INK,clamp(s1*.45,0.,.55));
  col=mix(col,CLAY,clamp(s2*.55,0.,.85));
  // 太阳：陶土色圆盘 + 一圈插画光芒 + 暖色光晕
  vec2 sd=p-uSun.xy;float sr=length(sd),R0=uSun.z,sa=atan(sd.y,sd.x);
  col=mix(col,vec3(.97,.78,.62),exp(-max(sr-R0,0.)/(R0*2.6))*.6);
  float rays=smoothstep(.9,.99,sin(sa*24.+uTime*.05)*.5+.5);
  float rlen=mix(1.85,2.55,step(.5,fract(sa*12./6.2832+.25)));
  rays*=smoothstep(R0*1.25,R0*1.4,sr)*smoothstep(R0*rlen,R0*(rlen-.25),sr);
  col=mix(col,CLAY,rays*.9);
  if(sr<R0*1.05){float mu=sqrt(max(1.-sr*sr/(R0*R0),0.));
    col=mix(col,mix(vec3(.9,.5,.36),vec3(.98,.74,.55),mu),smoothstep(R0*1.01,R0*.97,sr));}
  col=mix(col,INK,exp(-pow((sr-R0)*uRes.y/1.1,2.))*.55);
  // 行星：插画式明暗、阴影里的排线、细墨线描边
  for(int i=0;i<9;i++){
    vec4 B=uB[i];vec4 BC=uBc[i];
    if(B.z<=0.)continue;
    float k=B.w;
    if(k>3.5)col=ring(col,p,B,BC.rgb,0.);
    vec2 d=(p-B.xy)/B.z;float l2=dot(d,d);
    float px=B.z*uRes.y;
    if(l2<1.){
      vec3 n=vec3(d,sqrt(1.-l2));
      vec2 toS=uSun.xy-B.xy;vec3 L=normalize(vec3(toS,length(toS)*.35));
      float ndl=dot(n,L);
      float lon=atan(n.x,n.z)+uTime*(.04+BC.w*.06),lat=asin(clamp(n.y,-1.,1.));
      vec3 c=BC.rgb,sf;
      if(k<.5){sf=c*(.8+.35*fbm4(vec2(lon,lat)*3.+BC.w*10.));}
      else if(k<1.5){float land=smoothstep(.5,.56,fbm4(vec2(lon,lat)*2.2+BC.w*7.));
        sf=mix(vec3(.5,.66,.8),vec3(.66,.72,.52),land);
        float cl=smoothstep(.55,.75,fbm4(vec2(lon*1.4+uTime*.03,lat*3.)*2.+3.));sf=mix(sf,vec3(.98,.97,.95),cl*.8);}
      else{float bz=fbm4(vec2(lon*.8,lat*6.)+BC.w*5.);sf=c*(.8+.16*sin(lat*16.+bz*6.)+.18*bz);}
      float lit=smoothstep(-.12,.28,ndl);
      vec3 shade=sf*vec3(.6,.6,.68);
      vec3 pc=mix(shade,sf*1.04,lit);
      float hatch=smoothstep(.55,.45,abs(fract((fc.x+fc.y)/3.2)-.5)*2.);
      pc=mix(pc,INK,(1.-lit)*hatch*.16);
      pc=mix(pc,vec3(1.),pow(max(ndl,0.),18.)*.25);
      col=mix(col,pc,smoothstep(1.,1.-3./px,l2));
    }
    col=mix(col,INK,exp(-pow((sqrt(l2)-1.)*px/1.,2.))*.7);
    if(k>3.5)col=ring(col,p,B,BC.rgb,1.);
  }
  // 彗星：陶土色的尾巴
  if(uMet.w>0.){
    vec2 dir=vec2(cos(uMet.z),sin(uMet.z));float age=uMet.w;
    vec2 head=uMet.xy+dir*age*.8;vec2 rel=p-head;
    float al=-dot(rel,dir),pe=abs(dot(rel,vec2(-dir.y,dir.x)))*uRes.y;
    float fade=sin(3.14159*clamp(age/.95,0.,1.));
    if(al>0.&&al<.22)col=mix(col,CLAY,pow(1.-al/.22,1.5)*exp(-pe*pe/(2.+al*400.))*fade*.8);
    float hd=length(rel)*uRes.y;col=mix(col,INK,exp(-hd*hd/5.)*fade*.8);
  }
  float vig=1.-.07*dot(p/vec2(asp,1.),p/vec2(asp,1.))*2.;
  col*=vig;
  col+=(h1(fc+fract(uTime))-.5)/220.;
  gl_FragColor=vec4(col,1.);
}
void main(){if(uDay>.5)dayMain();else nightMain();}
`;
  const sh=(t,s)=>{const o=gl.createShader(t);gl.shaderSource(o,s);gl.compileShader(o);
    if(!gl.getShaderParameter(o,gl.COMPILE_STATUS)){console.warn(gl.getShaderInfoLog(o));return null}return o};
  const vs=sh(gl.VERTEX_SHADER,VS),fs=sh(gl.FRAGMENT_SHADER,FS);if(!vs||!fs)return {ok:false};
  const pg=gl.createProgram();gl.attachShader(pg,vs);gl.attachShader(pg,fs);gl.linkProgram(pg);
  if(!gl.getProgramParameter(pg,gl.LINK_STATUS))return {ok:false};
  gl.useProgram(pg);
  const buf=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buf);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,3,-1,-1,3]),gl.STATIC_DRAW);
  const loc=gl.getAttribLocation(pg,'a');gl.enableVertexAttribArray(loc);gl.vertexAttribPointer(loc,2,gl.FLOAT,false,0,0);
  const U={};for(const k of ['uRes','uTime','uMouse','uPtr','uLens','uMet','uGain','uSun','uB','uBc','uDay'])U[k]=gl.getUniformLocation(pg,k);
  const BB=new Float32Array(36),BC=new Float32Array(36);
  let scale=Math.min(devicePixelRatio||1,1.5),frames=0,acc=0,lens=0,met=null,next=2,gain=1;
  const fit=()=>{const w=Math.round(innerWidth*scale),h=Math.round(innerHeight*scale);if(c.width!==w||c.height!==h){c.width=w;c.height=h;gl.viewport(0,0,w,h)}};
  function draw(dt,time,mx,my,px,py,sys,day){
    fit();
    // 太卡就自动降分辨率
    if(dt>0){acc+=dt;if(++frames===90){if(acc/frames>.024&&scale>.6){scale=Math.max(.6,scale*.8);fit()}frames=0;acc=0}}
    lens*=Math.pow(.35,dt);
    const zen=document.documentElement.classList.contains('zen');
    gain+=((zen?.95:.7)-gain)*Math.min(1,dt*2);
    if(!calm){next-=dt;if(next<=0){next=zen?1.4+Math.random()*2.6:3.5+Math.random()*6;
      const a=innerWidth/innerHeight;met={x:(Math.random()-.25)*a*.6,y:.25+Math.random()*.3,ang:Math.PI+.5+(Math.random()-.5)*.25,age:0}}}
    if(met&&(met.age+=dt)>.95)met=null;
    const H=innerHeight;
    gl.uniform2f(U.uRes,c.width,c.height);gl.uniform1f(U.uTime,time);
    gl.uniform2f(U.uMouse,mx,-my);
    gl.uniform2f(U.uPtr,(px-innerWidth/2)/H,(H/2-py)/H);gl.uniform1f(U.uLens,lens);gl.uniform1f(U.uGain,gain);
    gl.uniform4f(U.uMet,met?met.x:0,met?met.y:0,met?met.ang:0,met?met.age:0);
    BB.fill(0);BC.fill(0);
    if(sys){gl.uniform3f(U.uSun,(sys.sun[0]-innerWidth/2)/H,(H/2-sys.sun[1])/H,sys.sun[2]/H);
      sys.bodies.slice(0,9).forEach((b,i)=>{BB.set([(b[0]-innerWidth/2)/H,(H/2-b[1])/H,b[2]/H,b[3]],i*4);BC.set([b[4],b[5],b[6],b[7]],i*4)})}
    else gl.uniform3f(U.uSun,0,-9,0);
    gl.uniform4fv(U.uB,BB);gl.uniform4fv(U.uBc,BC);gl.uniform1f(U.uDay,day?1:0);
    gl.drawArrays(gl.TRIANGLES,0,3);
  }
  addEventListener('pointermove',()=>{lens=Math.min(1,lens+.08)},{passive:true});
  return {ok:true,draw,canvas:c};
})();
// 背景动画：深色是深空（星云、银河、行星、流星），浅色是 Anthropic 风格的线描星轨。都会跟着鼠标动
(()=>{
  const cv=$('galaxy'),g=cv.getContext('2d');if(!g)return;
  const TAU=Math.PI*2,rnd=Math.random,gauss=()=>(rnd()+rnd()+rnd()+rnd()-2)/2;
  const off=(w,h)=>{const c=document.createElement('canvas');c.width=Math.max(1,Math.round(w));c.height=Math.max(1,Math.round(h));return c};
  const hexA=a=>Math.round(Math.max(0,Math.min(1,a))*255).toString(16).padStart(2,'0');
  let W=0,H=0,dpr=1,raf=0,last=0,clock=0,mode='',S=null;
  const m={x:-1e4,y:-1e4,nx:0,ny:0,sx:0,sy:0};
  addEventListener('pointermove',e=>{m.x=e.clientX;m.y=e.clientY;m.nx=e.clientX/W-.5;m.ny=e.clientY/H-.5},{passive:true});
  document.documentElement.addEventListener('mouseleave',()=>{m.x=m.y=-1e4;m.nx=m.ny=0});

  // ——— 深色：深空 ———
  const STAR_C=['#ffffff','#ffffff','#ffffff','#e6f1ff','#bce5ff','#9fd0ff','#ffe2b8','#ffc58a'];
  const glow=c=>{const s=64,o=off(s,s),x=o.getContext('2d'),gr=x.createRadialGradient(s/2,s/2,0,s/2,s/2,s/2);
    gr.addColorStop(0,'#fff');gr.addColorStop(.12,c);gr.addColorStop(.32,c+'44');gr.addColorStop(1,c+'00');
    x.fillStyle=gr;x.fillRect(0,0,s,s);return o};
  const GLOW=STAR_C.map(glow);
  const SPIKE=(()=>{const s=128,o=off(s,s),x=o.getContext('2d');
    for(const v of [0,1]){const gr=v?x.createLinearGradient(s/2,0,s/2,s):x.createLinearGradient(0,s/2,s,s/2);
      gr.addColorStop(0,'rgba(255,255,255,0)');gr.addColorStop(.5,'rgba(255,255,255,.9)');gr.addColorStop(1,'rgba(255,255,255,0)');
      x.fillStyle=gr;v?x.fillRect(s/2-.6,0,1.2,s):x.fillRect(0,s/2-.6,s,1.2)}
    return o})();

  function buildDark(){
    const M=70,bw=W+2*M,bh=H+2*M,mn=Math.min(bw,bh);
    // 银河带：从左下斜到右上
    const ang=-.52,ux=Math.cos(ang),uy=Math.sin(ang),vx=-uy,vy=ux,bcx=bw*.52,bcy=bh*.56,L=Math.hypot(bw,bh);
    const band=sp=>{const s=(rnd()-.5)*L,d=gauss()*sp;return [bcx+ux*s+vx*d,bcy+uy*s+vy*d]};
    // 星云（半分辨率，本来就是虚的）
    const q=.5,neb=off(bw*q,bh*q),n=neb.getContext('2d');n.scale(q,q);n.globalCompositeOperation='lighter';
    const NEB=['#1b2f6b','#2a1f5c','#4b2577','#6e2a6a','#1d5c7a','#23435f','#3b6a94','#1b2f6b'];
    const cloud=(x,y,r,c,a)=>{const gr=n.createRadialGradient(x,y,0,x,y,r);gr.addColorStop(0,c+hexA(a));gr.addColorStop(1,c+'00');n.fillStyle=gr;n.fillRect(x-r,y-r,2*r,2*r)};
    for(let i=0;i<80;i++){const [x,y]=band(mn*.15);cloud(x,y,60+rnd()*mn*.32,NEB[i%NEB.length],.05+rnd()*.12)}
    for(let i=0;i<14;i++){const [x,y]=band(mn*.12);cloud(x,y,40+rnd()*mn*.18,rnd()<.5?'#b0407a':'#1e7a8a',.05+rnd()*.07)}
    cloud(bcx+ux*L*.08,bcy+uy*L*.08,mn*.22,'#ff9a6a',.12);cloud(bcx+ux*L*.08,bcy+uy*L*.08,mn*.09,'#ffd6a8',.12);  // 暖色的银心
    cloud(bw*.1,bh*.16,mn*.5,'#3a1f63',.35);cloud(bw*.9,bh*.9,mn*.55,'#0f3355',.4);cloud(bw*.55,bh*.5,mn*.6,'#101a3a',.3);
    n.globalCompositeOperation='destination-out';   // 中间一道暗尘带，更像真的银河
    for(let i=0;i<90;i++){const [x,y]=band(mn*.025),r=18+rnd()*55,gr=n.createRadialGradient(x,y,0,x,y,r);
      gr.addColorStop(0,'rgba(0,0,0,.2)');gr.addColorStop(1,'rgba(0,0,0,0)');n.fillStyle=gr;n.fillRect(x-r,y-r,2*r,2*r)}
    // 远处的星：银河里密密麻麻的小星 + 全屏散星（一次画好）
    const far=off(bw*dpr,bh*dpr),f=far.getContext('2d');f.scale(dpr,dpr);
    const dot=(x,y,r,c,a)=>{f.globalAlpha=a;f.fillStyle=c;f.beginPath();f.arc(x,y,r,0,TAU);f.fill()};
    const nb=Math.round(bw*bh/240),na=Math.round(bw*bh/1600);
    for(let i=0;i<nb;i++){const [x,y]=band(mn*.1);dot(x,y,.22+rnd()*.5,rnd()<.85?'#fff':'#cfe6ff',.12+rnd()*.5)}
    for(let i=0;i<na;i++)dot(rnd()*bw,rnd()*bh,.3+rnd()*.65,STAR_C[(rnd()*STAR_C.length)|0],.18+rnd()*.6);
    f.globalAlpha=1;
    // 近处的亮星：会闪、会被鼠标推开、亮的带十字星芒
    const near=[],nn=Math.round(W*H/6500);
    for(let i=0;i<nn;i++){const big=rnd()<.13;
      near.push({x:rnd()*W,y:rnd()*H,z:.35+rnd()*.65,r:big?1.5+rnd()*1.6:.6+rnd()*1.1,c:(rnd()*STAR_C.length)|0,
        tw:rnd()*TAU,ts:.5+rnd()*2.4,spike:big,ox:0,oy:0,vx:0,vy:0})}
    // 右下角升起的一颗行星，左上边缘有一圈蓝色大气光
    const pr=Math.max(W,H)*.42,pd=Math.ceil(pr*2.5),pl=off(pd*dpr,pd*dpr),p=pl.getContext('2d');p.scale(dpr,dpr);
    const c0=pd/2;
    let gr=p.createRadialGradient(c0,c0,pr*.96,c0,c0,pr*1.2);gr.addColorStop(0,'rgba(91,165,255,.32)');gr.addColorStop(1,'rgba(91,165,255,0)');
    p.fillStyle=gr;p.fillRect(0,0,pd,pd);
    p.beginPath();p.arc(c0,c0,pr,0,TAU);p.fillStyle='#03050b';p.fill();p.save();p.clip();
    gr=p.createRadialGradient(c0+pr*.2,c0+pr*.26,pr*1.1,c0+pr*.2,c0+pr*.26,pr*1.33);
    gr.addColorStop(0,'rgba(120,190,255,0)');gr.addColorStop(.75,'rgba(120,190,255,.16)');gr.addColorStop(1,'rgba(210,235,255,.85)');
    p.fillStyle=gr;p.fillRect(0,0,pd,pd);
    p.restore();
    return {kind:'dark',M,bw,bh,neb,far,near,planet:{img:pl,d:pd,x:W*.95,y:H+pr*.5},meteors:[],next:1.5+rnd()*3};
  }

  function drawDark(dt){
    const s=S;g.globalCompositeOperation='source-over';g.globalAlpha=1;
    const drift=Math.sin(clock*.03)*14;
    g.drawImage(s.neb,-s.M-m.sx*30+drift,-s.M-m.sy*30,s.bw,s.bh);
    g.drawImage(s.far,-s.M-m.sx*55+drift*.6,-s.M-m.sy*55,s.bw,s.bh);
    g.globalCompositeOperation='lighter';
    const RAD=W<700?100:130,RAD2=RAD*RAD,spring=1-Math.pow(.3,dt),damp=Math.pow(.03,dt);
    for(const p of s.near){
      const x=p.x-m.sx*110*p.z,y=p.y-m.sy*110*p.z;
      const dx=x+p.ox-m.x,dy=y+p.oy-m.y,d2=dx*dx+dy*dy;
      let near=0;
      if(d2<RAD2*2){near=Math.exp(-d2/(RAD2*.5));const d=Math.sqrt(d2)||1;p.vx+=dx/d*near*2.2*60*dt;p.vy+=dy/d*near*2.2*60*dt}
      p.vx=(p.vx-p.ox*spring*3)*damp;p.vy=(p.vy-p.oy*spring*3)*damp;p.ox+=p.vx*dt*60;p.oy+=p.vy*dt*60;
      const X=x+p.ox,Y=y+p.oy;if(X<-40||Y<-40||X>W+40||Y>H+40)continue;
      const tw=.55+.45*Math.sin(clock*p.ts+p.tw),a=Math.min(1,(.5+.5*p.z)*tw+near*.8);
      const sz=p.r*6*(1+near*.5);g.globalAlpha=a;g.drawImage(GLOW[p.c],X-sz/2,Y-sz/2,sz,sz);
      if(p.spike){const k=p.r*14*(.75+.25*tw)*(1+near*.6);g.globalAlpha=a*.55;g.drawImage(SPIKE,X-k/2,Y-k/2,k,k)}
    }
    // 流星
    if(!calm){s.next-=dt;if(s.next<=0){s.next=document.documentElement.classList.contains('zen')?1.2+rnd()*2.6:3+rnd()*6;s.meteors.push({x:W*(.25+rnd()*.8),y:-20+rnd()*H*.35,dx:Math.cos(Math.PI*.78+gauss()*.1),dy:Math.sin(Math.PI*.78+gauss()*.1),v:700+rnd()*500,len:120+rnd()*140,age:0,life:.7+rnd()*.5})}}
    s.meteors=s.meteors.filter(t=>(t.age+=dt)<t.life);
    for(const t of s.meteors){const k=t.age/t.life,fade=Math.sin(Math.PI*k),hx=t.x+t.dx*t.v*t.age,hy=t.y+t.dy*t.v*t.age;
      const tx=hx-t.dx*t.len,ty=hy-t.dy*t.len,gr=g.createLinearGradient(tx,ty,hx,hy);
      gr.addColorStop(0,'rgba(180,220,255,0)');gr.addColorStop(1,'rgba(255,255,255,.95)');
      g.globalAlpha=fade;g.strokeStyle=gr;g.lineWidth=1.6;g.lineCap='round';g.beginPath();g.moveTo(tx,ty);g.lineTo(hx,hy);g.stroke();
      g.drawImage(GLOW[4],hx-9,hy-9,18,18)}
    // 行星在最前面，视差最大
    g.globalCompositeOperation='source-over';g.globalAlpha=1;
    const P=s.planet;g.drawImage(P.img,P.x-P.d/2-m.sx*150,P.y-P.d/2-m.sy*150,P.d,P.d);
  }

  // ——— 浅色：Anthropic 风格的线描星轨 ———
  const INK='#141413',CLAY='#d97757';
  function buildLight(){
    const R=Math.min(Math.max(W,H)*.5,820),TILT=.4,ROT=-.32;
    const radii=[.15,.27,.41,.57,.75,.96,1.22];
    const looks=[{f:CLAY,r:4.5},{f:INK,r:3},{f:'#faf9f5',s:INK,r:7,moon:1},{f:'#ebc9b7',s:INK,r:10},{f:'#3d3d3a',r:5.5,ring:1},{s:CLAY,r:6},{f:INK,r:2.5}];
    const planets=radii.map((rr,i)=>({rr,a:rnd()*TAU,w:.011/Math.pow(rr,1.5),...looks[i]}));
    const dust=[],nd=Math.round(W*H/6500);
    for(let i=0;i<nd;i++)dust.push({x:rnd()*W,y:rnd()*H,vx:(rnd()-.5)*7,vy:(rnd()-.5)*7,r:.7+rnd()*1.1,clay:rnd()<.16});
    const gs=160,grain=off(gs,gs),gx=grain.getContext('2d'),id=gx.createImageData(gs,gs);
    for(let i=0;i<id.data.length;i+=4){id.data[i]=id.data[i+1]=id.data[i+2]=20;id.data[i+3]=rnd()<.5?Math.round(rnd()*16):0}
    gx.putImageData(id,0,0);
    return {kind:'light',R,TILT,ROT,radii,planets,dust,grain:g.createPattern(grain,'repeat'),cx:W*(W<700?.72:.76),cy:H*.3};
  }

  function drawLight(dt){
    const s=S,cx=s.cx-m.sx*26,cy=s.cy-m.sy*26,cr=Math.cos(s.ROT),sr=Math.sin(s.ROT);
    const at=(rr,a)=>{const lx=Math.cos(a)*rr*s.R,ly=Math.sin(a)*rr*s.R*s.TILT;return [cx+lx*cr-ly*sr,cy+lx*sr+ly*cr]};
    g.globalCompositeOperation='source-over';g.globalAlpha=1;
    // 纸张颗粒
    g.fillStyle=s.grain;g.fillRect(0,0,W,H);
    // 轨道
    g.lineWidth=1;g.strokeStyle='rgba(20,20,19,.12)';
    s.radii.forEach((rr,i)=>{g.setLineDash(i===2||i===5?[1.5,6]:[]);g.lineCap='round';g.beginPath();g.ellipse(cx,cy,rr*s.R,rr*s.R*s.TILT,s.ROT,0,TAU);g.stroke()});
    g.setLineDash([]);
    // 太阳：陶土色光晕 + 慢慢转的星芒
    const sun=s.R*.05,halo=g.createRadialGradient(cx,cy,0,cx,cy,sun*6);
    halo.addColorStop(0,'rgba(217,119,87,.28)');halo.addColorStop(1,'rgba(217,119,87,0)');g.fillStyle=halo;g.fillRect(cx-sun*6,cy-sun*6,sun*12,sun*12);
    g.save();g.translate(cx,cy);g.rotate(clock*.05);g.strokeStyle=CLAY;g.lineCap='round';
    for(let i=0;i<12;i++){const a=i/12*TAU,l=sun*(i%2?1.05:1.6),w=i%2?2:3;g.lineWidth=w;g.beginPath();g.moveTo(Math.cos(a)*sun*.25,Math.sin(a)*sun*.25);g.lineTo(Math.cos(a)*l,Math.sin(a)*l);g.stroke()}
    g.restore();
    // 行星
    for(const p of s.planets){
      p.a+=p.w*dt;const [x,y]=at(p.rr,p.a);
      if(p.ring){g.strokeStyle='rgba(20,20,19,.55)';g.lineWidth=1;g.beginPath();g.ellipse(x,y,p.r*2.3,p.r*.7,-.35,0,TAU);g.stroke()}
      g.beginPath();g.arc(x,y,p.r,0,TAU);
      if(p.f){g.fillStyle=p.f;g.fill()}
      if(p.s){g.strokeStyle=p.s;g.lineWidth=1.2;g.stroke()}
      if(p.moon){const ma=clock*.6,mr=p.r*2.4;g.setLineDash([1,4]);g.strokeStyle='rgba(20,20,19,.3)';g.lineWidth=1;g.beginPath();g.arc(x,y,mr,0,TAU);g.stroke();g.setLineDash([]);
        g.fillStyle=INK;g.beginPath();g.arc(x+Math.cos(ma)*mr,y+Math.sin(ma)*mr,1.8,0,TAU);g.fill()}
    }
    drawDust(s.dust,dt);
  }

  // ——— 深色（GPU）：太阳系的轨道、小行星带；行星本体由着色器画 ———
  function buildSystem(day){
    const R=Math.min(Math.max(W,H)*.5,820),TILT=.36,ROT=-.3;
    const k=Math.min(1.3,Math.max(.75,Math.min(W,H)/800));
    const C=day?[[.74,.7,.64],[.95,.82,.6],[.5,.66,.8],[.86,.5,.38],[.93,.76,.62],[.92,.86,.72],[.7,.76,.9]]
               :[[.62,.6,.57],[.93,.8,.55],[.3,.5,.8],[.86,.42,.24],[.88,.7,.52],[.92,.82,.62],[.48,.82,.92]];
    const spec=[[.15,4*k,0,C[0]],[.24,6.5*k,0,C[1]],[.34,7.5*k,1,C[2],1],[.45,5.5*k,0,C[3]],
      [.72,23*k,2,C[4]],[.93,17*k,4,C[5]],[1.15,12*k,3,C[6]]];
    const bodies=spec.map(([rr,r,k,c,moon])=>({rr,r,k,c,moon:!!moon,a:rnd()*TAU,w:.022/Math.pow(rr,1.5),seed:rnd()}));
    const belt=[];for(let i=0;i<460;i++){const rr=.535+rnd()*.1+gauss()*.012;belt.push({rr,a:rnd()*TAU,w:.022/Math.pow(rr,1.5),s:.7+rnd()*1.3,al:.25+rnd()*.5})}
    return {R,TILT,ROT,bodies,belt,moon:0,day};
  }
  function drawSystem(dt){
    const s=S.sys,cx=W*(W<700?.66:.72)-m.sx*26,cy=H*.34-m.sy*26,cr=Math.cos(s.ROT),sr=Math.sin(s.ROT);
    const at=(rr,a)=>{const lx=Math.cos(a)*rr*s.R,ly=Math.sin(a)*rr*s.R*s.TILT;return [cx+lx*cr-ly*sr,cy+lx*sr+ly*cr,Math.sin(a)]};
    const pos=[];let hot=-1,best=46;
    s.bodies.forEach((b,i)=>{b.a+=b.w*dt;const [x,y,z]=at(b.rr,b.a),r=b.r*(1+.14*z);pos.push([x,y,r]);
      const d=Math.hypot(x-m.x,y-m.y)-r;if(d<best){best=d;hot=i}});
    // 轨道线：鼠标靠近哪颗行星，它的轨道就亮起来
    g.lineWidth=1;g.lineCap='round';
    s.bodies.forEach((b,i)=>{g.strokeStyle=s.day?(i===hot?'rgba(20,20,19,.5)':'rgba(20,20,19,.16)'):(i===hot?'rgba(190,212,255,.55)':'rgba(160,188,255,.17)');g.setLineDash(i===3||i===6?[1.5,6]:[]);
      g.beginPath();g.ellipse(cx,cy,b.rr*s.R,b.rr*s.R*s.TILT,s.ROT,0,TAU);g.stroke()});
    g.setLineDash([]);
    g.fillStyle=s.day?'#3d3d3a':'#d9cfbf';
    for(const p of s.belt){p.a+=p.w*dt;const [x,y,z]=at(p.rr,p.a);g.globalAlpha=p.al*(.7+.3*z);g.fillRect(x,y,p.s,p.s)}
    g.globalAlpha=1;
    s.moon+=dt*.8;
    const bodies=[];
    s.bodies.forEach((b,i)=>{const [x,y,r]=pos[i];bodies.push([x,y,r,b.k,...b.c,b.seed]);
      if(b.moon){const mr=r*3.4;bodies.push([x+Math.cos(s.moon)*mr,y+Math.sin(s.moon)*mr*.42,r*.34,0,.72,.72,.7,.3])}});
    return {sun:[cx,cy,s.R*.042],bodies};
  }

  function drawDust(dust,dt){
    g.globalCompositeOperation='source-over';
    // 星尘：鼠标附近的连成星座
    const near=[],RAD=W<700?140:190;
    for(const d of dust){
      d.x+=d.vx*dt;d.y+=d.vy*dt;if(d.x<-10)d.x=W+10;if(d.x>W+10)d.x=-10;if(d.y<-10)d.y=H+10;if(d.y>H+10)d.y=-10;
      const dm=Math.hypot(d.x-m.x,d.y-m.y),k=dm<RAD?1-dm/RAD:0;if(k>0)near.push([d,k]);
      g.globalAlpha=.2+k*.65;g.fillStyle=d.clay?CLAY:INK;g.beginPath();g.arc(d.x,d.y,d.r*(1+k*.6),0,TAU);g.fill();
    }
    g.lineWidth=.8;g.strokeStyle=INK;
    for(let i=0;i<near.length;i++)for(let j=i+1;j<near.length;j++){
      const [a,ka]=near[i],[b,kb]=near[j],dd=Math.hypot(a.x-b.x,a.y-b.y);if(dd>150)continue;
      g.globalAlpha=(1-dd/150)*Math.min(ka,kb)*.75;g.beginPath();g.moveTo(a.x,a.y);g.lineTo(b.x,b.y);g.stroke()}
    g.globalAlpha=1;
  }

  // ——— 调度 ———
  const theme=()=>document.documentElement.dataset.theme==='dark'?'dark':'light';
  function build(){
    dpr=Math.min(devicePixelRatio||1,2);W=innerWidth;H=innerHeight;
    cv.width=Math.round(W*dpr);cv.height=Math.round(H*dpr);mode=theme();
    const day=mode!=='dark';
    S=SPACE.ok?{kind:'gl',day,sys:buildSystem(day),dust:day?buildLight().dust:null}:(day?buildLight():buildDark());
    if(SPACE.ok)SPACE.canvas.style.opacity=S.kind==='gl'?1:0;
  }
  function render(dt){
    m.sx+=(m.nx-m.sx)*Math.min(1,dt*3);m.sy+=(m.ny-m.sy)*Math.min(1,dt*3);
    g.setTransform(dpr,0,0,dpr,0,0);g.clearRect(0,0,W,H);
    if(S.kind==='gl'){SPACE.draw(dt,clock,m.sx,m.sy,m.x,m.y,drawSystem(calm?0:dt),S.day);if(S.dust)drawDust(S.dust,dt)}else S.kind==='dark'?drawDark(dt):drawLight(dt);
  }
  // 工作台改动：背景限制在约 30 帧，页面滚动时暂停重画。背景每动一帧，上面所有毛玻璃都要重新模糊一遍，滚动时会抢显卡。
  let hold=0;addEventListener('scroll',()=>{hold=performance.now()+180},{capture:true,passive:true});
  function frame(now){
    if(!calm&&!document.hidden&&(now<hold||(last&&now-last<31))){raf=requestAnimationFrame(frame);return}
    const dt=Math.min((now-(last||now))/1000,.05);last=now;if(!calm)clock+=dt;
    render(dt);
    raf=0;if(!calm&&!document.hidden)raf=requestAnimationFrame(frame);
  }
  function sync(){
    if(theme()!==mode){build()}
    if(calm){last=0;frame(performance.now());return}
    if(document.hidden){if(raf)cancelAnimationFrame(raf);raf=0;return}
    if(!raf){last=0;raf=requestAnimationFrame(frame)}
  }
  let rt=0;addEventListener('resize',()=>{clearTimeout(rt);rt=setTimeout(()=>{build();if(calm)frame(performance.now())},120)});
  document.addEventListener('visibilitychange',sync);
  // 换主题：先把旧背景拍一张快照盖在上面，新背景立刻在下面画好，快照和卡片颜色用同样的 0.35 秒一起淡出
  const snap=document.createElement('canvas');snap.id='skySnap';cv.parentNode.appendChild(snap);
  const sc=snap.getContext('2d');let snapT=0;
  new MutationObserver(()=>{
    if(theme()===mode)return;
    if(S&&!document.hidden){
      render(0);
      snap.width=cv.width;snap.height=cv.height;sc.clearRect(0,0,snap.width,snap.height);
      if(S.kind==='gl')sc.drawImage(SPACE.canvas,0,0,snap.width,snap.height);
      sc.drawImage(cv,0,0);
      snap.style.transition='none';snap.style.opacity=1;void snap.offsetWidth;
      build();render(0);
      snap.style.transition='opacity .35s ease';snap.style.opacity=0;
      clearTimeout(snapT);snapT=setTimeout(()=>{snap.width=snap.height=1},500);
    }
    sync();
  }).observe(document.documentElement,{attributes:true,attributeFilter:['data-theme']});
  build();render(0);sync(); // 先同步画一帧，页面在后台打开时也不会是空背景
})();
})();
