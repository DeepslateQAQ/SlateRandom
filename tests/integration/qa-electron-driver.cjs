'use strict';
const {app,screen}=require('electron'),fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict');
const {execFile}=require('node:child_process'),{promisify}=require('node:util');
const nativeCommand=promisify(execFile);
const controller=require('../../src/main/main.cjs');
const output=process.env.SLATE_QA_OUTPUT,checks=[],errors=[],shots=[],nativeTouchReports=[];
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const wait=async(fn,timeout=20000)=>{const start=Date.now();while(Date.now()-start<timeout){try{if(await fn())return;}catch{}await pause(40);}throw Error('Desktop condition timed out after '+checks.at(-1));};
const check=(label,value)=>{assert.ok(value,label);checks.push(label);console.log('PASS '+label);};
const run=(win,fn,...args)=>win.webContents.executeJavaScript('('+fn.toString()+').apply(null,'+JSON.stringify(args)+')');
async function shot(win,name){await fs.writeFile(path.join(output,name),(await win.webContents.capturePage()).toPNG());shots.push(name);}
async function nativeTouchDrag(main,ball,area){
  assert.ok(process.argv.includes('--slate-qa')&&process.argv.some(arg=>arg.startsWith('--slate-user-data=')), 'Native touch QA requires its isolated, explicitly supplied data directory.');
  assert.ok(ball.isVisible()&&!main.isVisible()&&!controller.state().ball.confirming, 'Only the QA floating ball may receive injected touch input.');
  // Start well inside the display. Release will snap; while held it must stay
  // under the physical touch contact instead of repeatedly snapping or jumping.
  const center={x:area.x+Math.min(220,Math.round(area.width*.45)),y:area.y+Math.round(area.height*.38)};
  ball.setBounds({...center,width:76,height:76});await pause(100);
  const actual=ball.getBounds(),physicalStart=screen.dipToScreenPoint({x:actual.x+actual.width/2,y:actual.y+actual.height/2});
  // Finish eight DIP from the left edge: snapBall deliberately snaps only near
  // an edge, so an interior endpoint cannot assert a final edge attachment.
  const physicalEnd=screen.dipToScreenPoint({x:area.x+8+actual.width/2,y:actual.y+actual.height/2+Math.min(90,area.height*.12)});
  const moveX=physicalEnd.x-physicalStart.x,moveY=physicalEnd.y-physicalStart.y;
  const handle=ball.getNativeWindowHandle(),hwnd='0x'+(handle.length===8?handle.readBigUInt64LE():BigInt(handle.readUInt32LE())).toString(16);
  const reportName='desktop-native-touch.json',reportPath=path.join(output,reportName),watch=[];
  await run(ball,()=>{
    const qa=window.__nativeTouchQA={events:[],states:[]};
    const listener=event=>{if(event.pointerType==='touch')qa.events.push({type:event.type,trusted:event.isTrusted,at:Date.now(),screenX:event.screenX,screenY:event.screenY,clientX:event.clientX,clientY:event.clientY,windowScreenX:window.screenX,windowScreenY:window.screenY,devicePixelRatio:window.devicePixelRatio});};
    for(const type of ['pointerdown','pointermove','pointerup','pointercancel','lostpointercapture'])window.addEventListener(type,listener,true);
    const unsubscribe=slateDesktop.subscribe(state=>qa.states.push({at:Date.now(),snap:state.ball.snap,confirming:state.ball.confirming}));
    qa.cleanup=()=>{unsubscribe();for(const type of ['pointerdown','pointermove','pointerup','pointercancel','lostpointercapture'])window.removeEventListener(type,listener,true);};
  });
  // Observe every main-process native application, not one sample per injected
  // input. RAF smoothing and the main 16 ms timer are independent queues.
  const applications=[],setBounds=ball.setBounds,ownSetBounds=Object.getOwnPropertyDescriptor(ball,'setBounds');
  const physicalBounds=()=>{const bounds=ball.getBounds(),point=screen.dipToScreenPoint({x:bounds.x,y:bounds.y});return {...point,width:bounds.width,height:bounds.height};};
  ball.setBounds=function(...args){
    const beforeAt=Date.now(),beforeTick=process.hrtime.bigint().toString(),before=physicalBounds();
    const result=setBounds.apply(this,args);
    const after=physicalBounds();
    applications.push({beforeAt,at:Date.now(),beforeTick,tick:process.hrtime.bigint().toString(),before,after});
    return result;
  };
  const poll=setInterval(()=>{const beforeAt=Date.now(),bounds=ball.getBounds();watch.push({beforeAt,at:Date.now(),bounds,physical:screen.dipToScreenPoint({x:bounds.x,y:bounds.y}),snap:controller.state().ball.snap,confirming:controller.state().ball.confirming,ballVisible:ball.isVisible(),mainVisible:main.isVisible()});},16);
  let commandError,summary;
  try{
    const result=await nativeCommand('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(__dirname,'../native/inject-native-touch.ps1'),'-TargetProcessId',String(process.pid),'-WindowHandle',hwnd,'-OutputPath',reportPath,'-MoveX',String(moveX),'-MoveY',String(moveY),'-Steps','36','-StepMilliseconds','24','-StationaryMilliseconds','3200'],{windowsHide:true,timeout:20000,maxBuffer:1024*1024,encoding:'utf8'});
    summary=JSON.parse(result.stdout.trim());
  }catch(error){commandError=error;}
  finally{try{await pause(400);}finally{clearInterval(poll);if(ownSetBounds)Object.defineProperty(ball,'setBounds',ownSetBounds);else delete ball.setBounds;}}
  const renderer=await run(ball,()=>{const qa=window.__nativeTouchQA;qa.cleanup();return {events:qa.events,states:qa.states};});
  const report=JSON.parse(await fs.readFile(reportPath,'utf8').catch(()=>JSON.stringify({success:false,error:commandError?.message||'The native touch report was not created.'})));
  report.renderer=renderer;report.nativeWindowSamples=watch;report.nativeWindowApplications=applications;report.commandError=commandError?.message||null;
  await fs.writeFile(reportPath,JSON.stringify(report,null,2));nativeTouchReports.push(reportName);
  check('Win32 真实触摸注入 API 成功且触点已释放；不以合成 DOM 事件替代',!commandError&&summary?.success&&report.success&&report.initialized&&report.contactReleased);
  const down=renderer.events.find(event=>event.type==='pointerdown'),up=renderer.events.find(event=>event.type==='pointerup');
  check('Windows 注入被 Chromium 识别为可信 touch，包含连续移动与最终抬手',!!down?.trusted&&!!up?.trusted&&renderer.events.filter(event=>event.type==='pointermove'&&event.trusted).length>=12&&!renderer.events.some(event=>event.type==='pointercancel'));
  const moving=report.samples.filter(sample=>sample.phase==='move'),stationary=report.samples.filter(sample=>sample.phase==='stationary'),first=report.initialWindow;
  check('整个真实触摸拖动期间原生窗口宽高保持不变，移动不触发反复缩放',report.samples.every(sample=>sample.window.right-sample.window.left===first.right-first.left&&sample.window.bottom-sample.window.top===first.bottom-first.top));
  const scale=screen.getDisplayMatching(actual).scaleFactor,stepX=Math.abs(moveX)/36,stepY=Math.abs(moveY)/36;
  // These existing physical-pixel budgets apply to ONE actual main application,
  // never a possibly coalesced injector/poll interval. Do not scale by elapsed
  // time or forgive a jump because the previous sample accumulated lag.
  const limits={x:Math.ceil(stepX*3+8),y:Math.ceil(stepY*3+8)},reverse=Math.max(3,scale);
  const applied=applications.filter(sample=>sample.beforeAt>=down.at&&sample.at<up.at);
  const displacement=(before,after)=>['x','y'].every(axis=>{const delta=after[axis]-before[axis],direction=Math.sign(axis==='x'?moveX:moveY);return direction*delta>=-reverse&&Math.abs(delta)<=limits[axis];});
  const continuous=applied.length>=12&&applied.every(sample=>displacement(sample.before,sample.after));
  // Keep an independent input-relative lag AND overshoot contract. Reuse the
  // existing axis budgets; a stall cannot earn an unlimited catch-up allowance.
  // UTC brackets share the Windows clock. Equal millisecond timestamps are
  // ambiguous, so include all sends which could intersect the observation.
  const inputs=report.inputs||[],origin=inputs.find(input=>input.phase==='down');
  const timed=inputs.length===report.samples.length&&!!origin&&inputs.every((input,index)=>Number.isFinite(input.beforeAt)&&input.beforeAt<=input.at&&(!index||inputs[index-1].at<=input.beforeAt));
  const observations=[...report.samples.filter(sample=>sample.phase!=='up').map(sample=>({beforeAt:sample.beforeAt,at:sample.at,x:sample.window.left,y:sample.window.top})),...applied.map(sample=>({beforeAt:sample.beforeAt,at:sample.at,...sample.after})),...watch.filter(sample=>sample.beforeAt>=down.at&&sample.at<up.at).map(sample=>({beforeAt:sample.beforeAt,at:sample.at,...sample.physical}))];
  const tracking=timed?observations.map(sample=>{
    const prior=inputs.filter(input=>input.at<sample.beforeAt).at(-1)||origin;
    const possible=[prior,...inputs.filter(input=>input.beforeAt<=sample.at&&input.at>=sample.beforeAt)];
    const errors={};
    for(const axis of ['x','y']){
      const key=axis==='x'?'inputX':'inputY',start=axis==='x'?first.left:first.top,direction=Math.sign(axis==='x'?moveX:moveY)||1;
      const desired=possible.map(input=>start+input[key]-origin[key]),low=Math.min(...desired),high=Math.max(...desired);
      errors[axis]={lag:Math.max(0,direction>0?low-sample[axis]:sample[axis]-high),overshoot:Math.max(0,direction>0?sample[axis]-high:low-sample[axis])};
    }
    return {beforeAt:sample.beforeAt,at:sample.at,x:sample.x,y:sample.y,errors,ok:Number.isFinite(sample.beforeAt)&&sample.beforeAt<=sample.at&&['x','y'].every(axis=>errors[axis].lag<=limits[axis]&&errors[axis].overshoot<=limits[axis])};
  }):[];
  const tracksInput=timed&&tracking.length>0&&tracking.every(sample=>sample.ok);
  report.measurement={unit:'physical pixels',continuity:'each synchronous main setBounds before/after, not injector intervals or renderer frames',limits,reverse,inputTracking:'lag and overshoot independently bounded by existing axis budgets, including held settling',timed,continuous,tracksInput,appliedCount:applied.length,tracking};
  await fs.writeFile(reportPath,JSON.stringify(report,null,2));
  check('主进程每次原生位置应用有时间证据，移动滞后和超前各自不超过既有坐标预算',tracksInput);
  const held=stationary.slice(2),last=held.at(-1)||moving.at(-1);
  const expectedX=first.left+moveX,expectedY=first.top+moveY,tolerance=Math.max(8,scale*3);
  const heldApplications=applied.filter(sample=>held.length&&sample.beforeAt>=held[0].beforeAt),heldPoints=[...held.map(sample=>({x:sample.window.left,y:sample.window.top})),...heldApplications.flatMap(sample=>[sample.before,sample.after])];
  check('触摸拖动按物理坐标连续跟随，无反向抽搐、瞬移或停留时抖动',continuous&&moving.every((sample,index)=>{const before=index?moving[index-1].window:first;return Math.sign(moveX)*(sample.window.left-before.left)>=-reverse&&Math.sign(moveY)*(sample.window.top-before.top)>=-reverse;})&&moving.length===36&&held.length>=40&&Math.abs(last.window.left-expectedX)<=tolerance&&Math.abs(last.window.top-expectedY)<=tolerance&&Math.max(...heldPoints.map(sample=>sample.x))-Math.min(...heldPoints.map(sample=>sample.x))<=tolerance&&Math.max(...heldPoints.map(sample=>sample.y))-Math.min(...heldPoints.map(sample=>sample.y))<=tolerance);
  const started=renderer.states.find(state=>state.snap==='none'),during=watch.filter(sample=>started&&sample.at>=started.at&&sample.at<up.at);
  check('触摸拖动及超过 3 秒停留期间不提前吸附、不打开主界面或退出确认',!!started&&during.length>=100&&during.every(sample=>sample.snap==='none'&&!sample.confirming&&!sample.mainVisible&&sample.ballVisible)&&renderer.states.filter(state=>state.at<up.at).every(state=>!state.confirming));
  const final=ball.getBounds(),finalArea=screen.getDisplayMatching(final).workArea;
  const snapTransitions=renderer.states.filter(state=>state.at>=up.at&&state.snap!=='none');
  check('触摸释放后完成一次边缘吸附，悬浮球仍无焦点且主界面隐藏',snapTransitions.length===1&&['left','right'].includes(controller.state().ball.snap)&&(final.x===finalArea.x||final.x+final.width===finalArea.x+finalArea.width)&&!main.isVisible()&&ball.isVisible()&&!ball.isFocused()&&!controller.state().ball.confirming);
}
async function interruptedTouchRecovery(main,ball){
  assert.ok(ball.isVisible()&&!main.isVisible()&&!controller.state().ball.confirming,'Interrupted-contact recovery starts with only the collapsed QA ball visible.');
  // Deliberately DOM-only contact: no trusted/native touch is claimed here.
  // Omit pointerup/pointercancel to reproduce a stranded renderer touch hold.
  await run(ball,()=>{
    const button=document.getElementById('floatingBallButton'),bounds=button.getBoundingClientRect();
    const clientX=bounds.left+bounds.width/2,clientY=bounds.top+bounds.height/2;
    button.dispatchEvent(new PointerEvent('pointerdown',{pointerId:8091,pointerType:'touch',isPrimary:true,button:0,buttons:1,bubbles:true,clientX,clientY,screenX:window.screenX+clientX,screenY:window.screenY+clientY}));
  });
  await wait(()=>run(ball,()=>{const button=document.getElementById('floatingBallButton');return button.classList.contains('is-holding')&&button.classList.contains('is-hovered');}));
  check('DOM-only 合成主触点未抬起，确实进入悬浮球按住与悬停状态（非原生触摸证明）',await run(ball,()=>!document.hidden));
  await run(ball,()=>slateDesktop.openMain());
  await wait(()=>run(ball,()=>{const button=document.getElementById('floatingBallButton');return !button.classList.contains('is-holding')&&!button.classList.contains('is-hovered');}));
  check('隐藏悬浮球同步页面可见性并清除中断触点',main.isVisible()&&!ball.isVisible()&&await run(ball,()=>document.hidden));
  await run(main,()=>slateDesktop.hideMain());
  await wait(()=>!main.isVisible()&&ball.isVisible());
  check('主界面返回后中断触点不再占用球体，按住与悬停保持清除',await run(ball,()=>{const button=document.getElementById('floatingBallButton');return !document.hidden&&!button.classList.contains('is-holding')&&!button.classList.contains('is-hovered');}));
  const center=await run(ball,()=>{const bounds=document.getElementById('floatingBallButton').getBoundingClientRect();return {x:Math.round(bounds.left+bounds.width/2),y:Math.round(bounds.top+bounds.height/2)};});
  // Chromium mouse input exercises renderer dispatch, not Win32 hit testing.
  ball.webContents.sendInputEvent({type:'mouseMove',...center});
  ball.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...center});
  ball.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...center});
  await wait(()=>main.isVisible()&&!ball.isVisible()&&main.getOpacity()===1);
  check('中断触点往返后 Chromium 真实鼠标输入仍可打开主界面（非 OS 命中测试证明）',main.isVisible()&&!ball.isVisible());
  await run(main,()=>slateDesktop.hideMain());
  await wait(()=>!main.isVisible()&&ball.isVisible());
}
async function scenePerformance(main,ball){
  assert.ok(process.argv.includes('--slate-qa')&&process.argv.some(arg=>arg.startsWith('--slate-user-data=')), 'Performance QA requires an isolated, explicitly supplied data directory.');
  const {createHash}=require('node:crypto'),{fileURLToPath}=require('node:url');
  const {makeScenePerformanceFixture,measureScenePerformance}=await import('../native/measure-scene-performance.mjs');
  const artifactPath=path.resolve(__dirname,'../../dist/index.html');
  assert.equal(fileURLToPath(main.webContents.getURL()),artifactPath,'Performance QA must measure the actual built HTML.');
  const html=await fs.readFile(artifactPath),hash=value=>createHash('sha256').update(value).digest('hex');
  const viewport={width:768,height:432,deviceScaleFactor:2.5,mobile:false};
  const report={completed:false,startedAt:new Date().toISOString(),artifactBytes:html.length,artifactSha256:hash(html),
    packageVersion:require('../../package.json').version,nodeVersion:process.versions.node,electronVersion:process.versions.electron,chromeVersion:process.versions.chrome,platform:process.platform,arch:process.arch,
    viewport,reducedMotion:'no-preference',fixtureDate:'2026-10-15T06:00:00Z',timeSource:'datetime',timePositions:[1,2],
    matrix:{modes:['normal','direction','time'],renderStyles:['normal','overview'],studentCounts:[47,500],historyLengths:[1,2000],cells:24,repetitions:3,expectedSamples:72},samples:[]};
  const reportPath=path.join(output,'scene-performance-report.json');
  let current=null,attached=false;
  const reload=()=>new Promise((resolve,reject)=>{
    const contents=main.webContents;
    const cleanup=()=>{clearTimeout(timer);contents.removeListener('did-finish-load',loaded);contents.removeListener('did-fail-load',failed);};
    const loaded=()=>{cleanup();resolve();};
    const failed=(_event,code,description,_url,isMainFrame)=>{if(isMainFrame){cleanup();reject(Error('Performance reload failed: '+code+' '+description));}};
    const timer=setTimeout(()=>{cleanup();reject(Error('Performance reload timed out.'));},30000);
    contents.once('did-finish-load',loaded);contents.on('did-fail-load',failed);contents.reload();
  });
  try{
    ball.hide();main.show();main.focus();
    assert.ok(!main.webContents.debugger.isAttached(),'Performance QA owns its CDP metrics session.');
    main.webContents.debugger.attach('1.3');attached=true;
    await main.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride',viewport);
    await main.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
    for(const mode of report.matrix.modes)for(const renderStyle of report.matrix.renderStyles)for(const studentCount of report.matrix.studentCounts)for(const historyLength of report.matrix.historyLengths){
      const cell={mode,renderStyle,studentCount,historyLength};current=cell;
      const fixtureStarted=performance.now();
      const fixture=await run(main,makeScenePerformanceFixture,cell),fixtureSha256=hash(JSON.stringify(fixture)),fixtureGenerationMs=performance.now()-fixtureStarted;
      for(let repetition=1;repetition<=3;repetition++){
        current={...cell,repetition};
        const setupStarted=performance.now();
        await run(main,state=>{slateDesktop.data.saveClass(state);},fixture);
        await reload();
        await wait(()=>run(main,(count,style)=>document.readyState==='complete'&&!!window.DrawCore&&window.slateDesktop?.role==='main'
          &&document.querySelectorAll('[data-mode-row]').length===5&&document.querySelectorAll('#liveSeats [data-live-student]').length===count
          &&document.querySelector('.draw-screen')?.dataset.renderStyle===style&&document.getElementById('drawBtn')?.getAttribute('aria-busy')==='false'
          &&!document.getElementById('drawBtn').disabled&&!document.querySelector('dialog[open]'),studentCount,renderStyle),30000);
        await run(main,async()=>{await document.fonts.ready;await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));});
        await pause(1000);
        const before=await run(main,()=>({state:slateDesktop.data.loadClass(),viewport:{width:innerWidth,height:innerHeight,devicePixelRatio},reducedMotion:matchMedia('(prefers-reduced-motion: reduce)').matches,noPreference:matchMedia('(prefers-reduced-motion: no-preference)').matches}));
        assert.equal(hash(JSON.stringify(before.state)),fixtureSha256,'Fresh reload must retain the identical fixture: '+JSON.stringify(current));
        assert.equal(before.viewport.width,viewport.width);assert.equal(before.viewport.height,viewport.height);
        assert.ok(Math.abs(before.viewport.devicePixelRatio-viewport.deviceScaleFactor)<1e-6,'Actual DPR must match the requested scale within browser floating-point precision.');
        assert.equal(before.reducedMotion,false,'Performance measurement must not reduce animations.');
        assert.equal(before.noPreference,true,'Performance media emulation must explicitly be no-preference.');
        const setupDurationMs=performance.now()-setupStarted;
        const measurement=await run(main,measureScenePerformance,{timeoutMs:30000});
        const after=await run(main,()=>{const state=slateDesktop.data.loadClass();return {round:state.round,historyLength:state.history.length,record:state.history.at(-1)};});
        const record=after.record;
        assert.equal(after.round,fixture.round+1,'Exactly one real draw must commit.');
        assert.equal(after.historyLength,Math.min(2000,historyLength+1));
        assert.ok(record?.mode===mode&&!record.switchedFrom&&!record.fallback,'Performance cell unavailable: unexpected fallback '+JSON.stringify({cell:current,record}));
        if(mode==='direction')assert.ok(record.direction,'Direction cell must use a real neighboring target.');
        if(mode==='time')assert.ok(record.studentId==='20'&&!record.timeRule?.replacedPositions&&record.timeRule?.positions.join(',')==='1,2','Time cell must use the fixed datetime target, not alternate positions.');
        assert.equal(measurement.seats,studentCount);assert.equal(measurement.renderStyle,renderStyle);
        assert.deepEqual(measurement.viewport,before.viewport);assert.ok(measurement.frames>15,'The real animation must produce frame samples.');
        report.samples.push({...current,requestedMode:mode,fixtureSha256,fixtureRngState:fixture.rngState,fixtureGenerationMs,setupDurationMs,
          initialRound:fixture.round,initialHistoryLength:historyLength,actualMode:record.mode,fallback:record.fallback,
          reducedMotion:{reduce:before.reducedMotion,noPreference:before.noPreference},record,...measurement});
        console.log('Scene performance '+JSON.stringify(report.samples.at(-1)));
      }
    }
    assert.equal(report.samples.length,72);assert.equal(errors.length,0,'No renderer or preload errors during performance measurement.');
    assert.equal(hash(await fs.readFile(artifactPath)),report.artifactSha256,'Built HTML changed during performance measurement.');
    report.completed=true;report.completedAt=new Date().toISOString();report.runtimeErrors=errors;
    await fs.writeFile(reportPath,JSON.stringify(report,null,2));
  }catch(error){
    report.failedCell=current;report.error=error.stack;report.runtimeErrors=errors;
    await fs.writeFile(path.join(output,'scene-performance-partial-report.json'),JSON.stringify(report,null,2));throw error;
  }finally{if(attached&&main.webContents.debugger.isAttached())main.webContents.debugger.detach();}
}
/** The first launch of a fresh profile must land in the flow, then hand the app
 *  back to the classic floating-ball checks below. */
async function firstRunFlow(main,ball){
  await wait(()=>main.isVisible());
  check('首次启动直接显示主窗口并隐藏悬浮球',main.isVisible()&&!ball.isVisible());
  check('首次启动打开全窗口引导并停在欢迎页',await run(main,()=>{const dialog=document.getElementById('onboardingDialog');return dialog.open===true&&document.getElementById('onboardingTitle').textContent.includes('SlateRandom 岩选')&&!!document.getElementById('onboardingStartBtn')&&!!document.getElementById('onboardingImportBackupBtn')&&!!document.getElementById('onboardingBackupFile')&&!!document.getElementById('onboardingSkipBtn');}));
  await shot(main,'desktop-onboarding-welcome.png');
  await wait(()=>run(main,()=>document.getElementById('onboardingStartBtn')?.disabled===false),6000);
  await run(main,()=>document.getElementById('onboardingStartBtn').click());
  await wait(()=>run(main,()=>document.querySelector('[data-onboarding-step="appearance"]')));
  check('引导第一步展示外观预览与明暗主题切换',await run(main,()=>!!document.getElementById('onboardingAppearancePreview')&&document.querySelectorAll('[data-onboarding-theme]').length===4&&!!document.getElementById('onboardingRadiusInput')));
  await shot(main,'desktop-onboarding-appearance.png');
  await run(main,()=>document.getElementById('onboardingNextBtn').click());
  await wait(()=>run(main,()=>document.querySelector('[data-onboarding-step="general"]')));
  check('桌面步骤展示开机自启、提权方式与 UIAccess，默认未启用 UIAccess',await run(main,()=>!!document.getElementById('onboardingAutostartInput')&&!!document.getElementById('onboardingElevationMethod')&&document.getElementById('onboardingUiAccessInput').disabled===true));
  const elevationBefore=controller.state().settings.manualElevation;
  await run(main,()=>document.querySelector('#onboardingElevationMethod input[value=compatibility]').click());
  await pause(150);
  check('提权方式只写入引导草稿，完成前不改动已保存设置',controller.state().settings.manualElevation===elevationBefore&&await run(main,()=>document.querySelector('#onboardingElevationMethod input[value=compatibility]').checked===true));
  await shot(main,'desktop-onboarding-desktop.png');
  await run(main,()=>document.getElementById('onboardingBackBtn').click());
  await wait(()=>run(main,()=>document.querySelector('[data-onboarding-step="appearance"]')));
  await run(main,()=>document.getElementById('onboardingBackBtn').click());
  await wait(()=>run(main,()=>document.querySelector('[data-onboarding-step="welcome"]')));
  await wait(()=>run(main,()=>document.getElementById('onboardingSkipBtn')?.disabled===false));
  await run(main,()=>document.getElementById('onboardingSkipBtn').click());
  await wait(()=>run(main,()=>document.getElementById('onboardingDialog').open===false));
  check('跳过引导后关闭全窗口引导并保留主界面',await run(main,()=>document.getElementById('onboardingDialog').open===false&&!!document.getElementById('drawBtn')&&slateDesktop.data.loadClass()?.settings?.onboardingCompleted===true));
  // A never-shown native window can freeze its CSS transition timeline. The
  // ball takes over here, shown without focus, so the rendered confirmation is real.
  await run(main,()=>slateDesktop.hideMain());
  await wait(()=>ball.isVisible()&&!main.isVisible());
  ball.showInactive();
  check('跳过引导后主界面收起并恢复可交互的悬浮球',ball.isVisible()&&!main.isVisible());
}
app.whenReady().then(async()=>{
  try{
    await wait(()=>controller.isReady());const {main,ball}=controller.getWindows();
    for(const win of [main,ball]){win.webContents.on('console-message',details=>{if(details.level==='error')errors.push(details.message);});win.webContents.on('preload-error',(_event,_file,error)=>errors.push(error.message));}
    await wait(()=>run(ball,()=>document.querySelector('#floatingBallButton') && window.slateDesktop?.role==='ball'));
    await wait(()=>run(main,()=>document.querySelector('#drawBtn') && document.querySelectorAll('[data-mode-row]').length===5));
    await run(ball,()=>document.fonts.ready);await run(main,()=>document.fonts.ready);
    await firstRunFlow(main,ball);
    if(process.argv.includes('--slate-performance')){await scenePerformance(main,ball);app.exit(0);return;}
    check('Electron 真实创建两个隔离窗口，悬浮球与主程序分别挂载',await run(ball,()=>!document.getElementById('drawBtn')&&!!document.getElementById('floatingBall'))&&await run(main,()=>!document.getElementById('floatingBall')&&!!document.getElementById('drawBtn')));
    check('主窗口无边框、不可缩放并处于置顶，悬浮球也置顶',!main.isResizable()&&!main.isMaximizable()&&!main.isFullScreenable()&&main.isAlwaysOnTop()&&ball.isAlwaysOnTop());
    check('悬浮球不接受原生窗口焦点',!ball.isFocusable()&&!ball.isFocused());
    check('主进程以真实 Windows token 返回权限，默认不启用 UAC/UIAccess 或自启',!controller.state().settings.uac&&!controller.state().settings.uiAccess&&!controller.state().settings.autostart&&typeof controller.state().runtime.elevated==='boolean');
    check('球体主题色核心与舞台外壳使用同一套 token，Material shuffle 字形实际渲染',await run(ball,()=>{const e=document.getElementById('floatingBallButton'),s=getComputedStyle(e),icon=e.querySelector('.material-icon');const colorOf=value=>{const probe=document.createElement('i');probe.style.background=value;document.body.appendChild(probe);const color=getComputedStyle(probe).backgroundColor;probe.remove();return color;};return s.backgroundColor===colorOf('var(--color-accent)')&&s.borderTopColor===colorOf('var(--ball-shell)')&&s.borderRadius==='50%'&&icon.textContent==='shuffle'&&getComputedStyle(icon).fontFamily.includes('Material');}));
    await shot(ball,'desktop-ball-right.png');
    const area=screen.getDisplayMatching(ball.getBounds()).workArea;
    await nativeTouchDrag(main,ball,area);
    await interruptedTouchRecovery(main,ball);
    const dragBall=async(x,y)=>{const old=ball.getBounds();await run(ball,async(dx,dy)=>{await slateDesktop.dragStart();slateDesktop.dragMove({dx,dy});await new Promise(r=>setTimeout(r,80));await slateDesktop.dragEnd();},x-old.x,y-old.y);await pause(350);};
    await dragBall(area.x+8,area.y+130);
    check('左侧吸附到实际工作区边缘，外壳连接无透明间隙',ball.getBounds().x===area.x&&controller.state().ball.snap==='left'&&await run(ball,()=>{const e=document.querySelector('.floating-ball-surface');const probe=document.createElement('i');probe.style.background='var(--ball-shell)';document.body.appendChild(probe);const shell=getComputedStyle(probe).backgroundColor;probe.remove();return e.getBoundingClientRect().left===0&&getComputedStyle(e).backgroundColor===shell;}));
    await shot(ball,'desktop-ball-left.png');
    await dragBall(area.x+area.width-84,area.y+170);
    check('右侧吸附以及高低位置边界由主进程限制',ball.getBounds().x+ball.getBounds().width===area.x+area.width&&controller.state().ball.snap==='right');
    const pointerDown=()=>{const e=document.getElementById('floatingBallButton');e.dispatchEvent(new PointerEvent('pointerdown',{pointerId:1,pointerType:'mouse',button:0,isPrimary:true,bubbles:true,screenX:100,screenY:100}));};
    await run(ball,pointerDown);await pause(1500);
    check('长按使用绿色球体外的环形进度，中途可见且没有背景横向填充',await run(ball,()=>{
      const core=document.getElementById('floatingBallButton'),svg=core.querySelector('.floating-ball-hold-ring'),arc=svg?.querySelector('circle');
      if(!svg||!arc)return false;
      const box=core.getBoundingClientRect(),ring=svg.getBoundingClientRect(),style=getComputedStyle(arc),outer=Number(arc.getAttribute('r'))+parseFloat(style.strokeWidth)/2;
      return core.classList.contains('is-holding')&&Number(getComputedStyle(svg).opacity)>.99&&parseFloat(style.strokeDashoffset)>0&&parseFloat(style.strokeDashoffset)<100&&style.animationDuration==='3s'&&style.animationTimingFunction!=='linear'&&outer>28&&outer<32&&ring.left>=0&&ring.right<=innerWidth+.5&&Math.abs(ring.width-box.width)<.5&&getComputedStyle(core,'::after').content==='none';
    }));
    await shot(ball,'desktop-ball-progress.png');await pause(1600);
    await wait(()=>controller.state().ball.confirming);await pause(500);
    check('长按 3 秒横向展开关闭确认，右边圆球位置保持',ball.getBounds().width===348&&ball.getBounds().x+348===area.x+area.width&&await run(ball,()=>document.querySelector('.floating-confirm-text').textContent.includes('是否关闭 SlateRandom')&&document.getElementById('confirmQuitBtn').getBoundingClientRect().width>30));
    console.log('Confirmation rendering: '+JSON.stringify(await run(ball,()=>{const t=document.querySelector('.floating-confirm-text'),g=t.closest('.floating-ball-confirmation'),s=t.closest('.floating-ball-surface');return {opacity:getComputedStyle(g).opacity,color:getComputedStyle(t).color,text:t.getBoundingClientRect().toJSON(),surface:s.getBoundingClientRect().toJSON(),viewport:[innerWidth,innerHeight],dataset:{...document.getElementById('floatingBall').dataset}};})));
    check('关闭确认文字与两个按钮在球体旁实际可见且颜色有对比',await run(ball,()=>{const text=document.querySelector('.floating-confirm-text'),group=text.closest('.floating-ball-confirmation'),surface=text.closest('.floating-ball-surface'),t=text.getBoundingClientRect(),s=surface.getBoundingClientRect();const probe=document.createElement('i');probe.style.color='var(--ball-text)';document.body.appendChild(probe);const textColor=getComputedStyle(probe).color;probe.remove();return Number(getComputedStyle(group).opacity)>.99&&getComputedStyle(text).color===textColor&&t.left>=s.left&&t.right<=s.right&&t.width>60;}));
    await shot(ball,'desktop-ball-confirm.png');
    await run(ball,()=>{document.getElementById('cancelQuitBtn').click();document.getElementById('floatingBallButton').dispatchEvent(new PointerEvent('pointerup',{pointerId:1,bubbles:true}));});
    await wait(()=>!controller.state().ball.confirming&&ball.getBounds().width===76);
    check('取消退出收回球体，程序和班级状态继续存在',!ball.isDestroyed()&&!main.isDestroyed());
    await run(ball,()=>slateDesktop.openMain());
    check('点击悬浮球弹出主界面，并居中保留四周边距',main.isVisible()&&(()=>{const b=main.getBounds(),a=screen.getDisplayMatching(b).workArea;return b.x>a.x&&b.y>a.y&&b.x+b.width<a.x+a.width&&b.y+b.height<a.y+a.height&&Math.abs(b.x+b.width/2-a.x-a.width/2)<=1&&Math.abs(b.y+b.height/2-a.y-a.height/2)<=1;})());
    check('主界面打开后悬浮球自动隐藏',!ball.isVisible()&&!ball.isFocused());
    main.focus();await wait(()=>main.isFocused());
    main.setAlwaysOnTop(false);ball.setAlwaysOnTop(false);
    await wait(()=>main.isAlwaysOnTop()&&ball.isAlwaysOnTop(),3500);
    check('定时置顶恢复两个窗口的置顶状态且不显示隐藏球、不转移主界面焦点',main.isVisible()&&!ball.isVisible()&&main.isFocused()&&!ball.isFocused());
    check('主界面左下角使用低亮度红色关闭图标，不使用整块红色背景',await run(main,()=>{const e=document.getElementById('desktopCloseMainBtn'),b=e.getBoundingClientRect(),s=getComputedStyle(e),surface=document.querySelector('.draw-screen').getBoundingClientRect();return b.left-surface.left<=25&&surface.bottom-b.bottom<=25&&s.backgroundColor!=='rgb(255, 82, 82)'&&e.querySelector('.material-icon').textContent==='close'&&s.color!==getComputedStyle(document.getElementById('drawBtn')).color;}));
    check('首次使用没有演示名单或虚假学生',await run(main,()=>document.querySelectorAll('.live-seat[data-live-student]').length===0&&document.querySelectorAll('#rosterList [data-student]').length===0));
    await run(main,()=>document.getElementById('drawBtn').click());
    await wait(()=>run(main,()=>document.getElementById('configDialog').open&&document.querySelector('[data-nav=roster]')?.getAttribute('aria-current')==='page'));
    check('空名单点击抽选直接进入名单与座位配置，不产生抽选记录',await run(main,()=>document.getElementById('configDialog').open&&document.querySelector('[data-nav=roster]').getAttribute('aria-current')==='page'&&!document.querySelector('.draw-screen').classList.contains('is-animating')&&document.querySelectorAll('.live-seat[data-live-student]').length===0));
    await run(main,()=>DialogTransitions.close(document.getElementById('configDialog')));
    await shot(main,'desktop-main.png');
    await run(main,()=>document.getElementById('desktopCloseMainBtn').click());await wait(()=>!main.isVisible());
    check('红色关闭按钮隐藏主界面并恢复悬浮球，程序继续运行',!ball.isDestroyed()&&!main.isDestroyed()&&ball.isVisible());
    await pause(1650);
    check('悬浮球显示后持续置顶且不获取焦点或重新显示主界面',ball.isVisible()&&!ball.isFocusable()&&!ball.isFocused()&&ball.isAlwaysOnTop()&&!main.isVisible());
    await run(ball,()=>slateDesktop.openMain());
    await run(main,()=>{document.getElementById('resetDrawBtn').inert=true;window.__quitSiblingInert=Array.from(document.querySelector('.home-actions').children).filter(e=>!e.classList.contains('desktop-close-main')).map(e=>({id:e.id,inert:e.inert}));});
    const closeBounds=await run(main,()=>{const b=document.getElementById('desktopCloseMainBtn').getBoundingClientRect();return {x:Math.round(b.left+b.width/2),y:Math.round(b.top+b.height/2)};});
    main.webContents.sendInputEvent({type:'mouseMove',...closeBounds});main.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...closeBounds});
    await pause(650);main.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...closeBounds});
    await wait(()=>run(main,()=>document.querySelector('.desktop-close-main')?.classList.contains('is-confirming')));await pause(500);
    check('主界面关闭键长按 500 ms 展开退出确认，确认文字实际可见',main.isVisible()&&await run(main,()=>{const group=document.querySelector('.desktop-main-quit-confirmation'),b=group.getBoundingClientRect();return getComputedStyle(group).opacity==='1'&&b.width>170&&document.getElementById('confirmMainQuitBtn').getBoundingClientRect().width>=30;}));
    check('退出确认使主页动作兄弟 inert，隐藏动作不能获取焦点',await run(main,()=>{const group=document.querySelector('[data-main-quit-confirming="true"]');return !!group&&Array.from(group.parentElement.children).filter(e=>e!==group).every(e=>{if(!e.inert)return false;e.focus();return document.activeElement!==e;});}));
    await run(main,()=>document.getElementById('cancelMainQuitBtn').focus());
    main.webContents.sendInputEvent({type:'keyDown',keyCode:'Space'});await pause(650);
    check('退出确认期间 Space 不会打开主页配置',await run(main,()=>!document.getElementById('configDialog').open));
    main.webContents.sendInputEvent({type:'keyUp',keyCode:'Space'});
    await wait(()=>run(main,()=>!document.querySelector('.desktop-close-main')?.classList.contains('is-confirming')));
    check('主界面退出确认可以取消，两个窗口保持运行',main.isVisible()&&!ball.isDestroyed());
    check('键盘取消后精确恢复兄弟原 inert，包括原本 inert 的控件',await run(main,()=>window.__quitSiblingInert.every(({id,inert})=>document.getElementById(id).inert===inert)));
    await run(main,()=>{document.getElementById('resetDrawBtn').inert=false;document.getElementById('drawBtn').focus();});
    await run(main,async()=>{await DialogTransitions.open(document.getElementById('configDialog'));document.querySelector('[data-nav=general]').click();await new Promise(r=>setTimeout(r,350));});
    check('设置导航按通用、功能、名单、数据、帮助、关于六页分区',await run(main,()=>Array.from(document.querySelectorAll('#configDialog [data-nav]'),e=>e.dataset.nav).join('|')==='general|dashboard|roster|data|help|about'));
    check('通用设置提供开机自启、UIAccess 和单组三段原生提权选择器',await run(main,()=>{const group=document.getElementById('desktopElevationMethod'),radios=Array.from(group.querySelectorAll('input[type=radio]'));return document.getElementById('desktopAutostartInput')&&!document.getElementById('desktopAutostartInput').checked&&document.getElementById('desktopUiAccessInput').disabled&&group.tagName==='FIELDSET'&&group.classList.contains('elevation-mode-picker')&&radios.map(input=>input.value).join('|')==='disabled|uac|compatibility'&&radios.every(input=>input.name==='elevationMethod')&&group.querySelectorAll('input:checked').length===1&&group.querySelector('input[value=disabled]').checked&&!group.querySelector('input[type=range]');}));
    const ballPreference=controller.state().settings.showFloatingBall;
    check('通用设置与托盘菜单提供同一个显示悬浮球开关',await run(main,value=>{const input=document.getElementById('desktopShowBallInput');return !!input&&!input.disabled&&input.checked===value;},ballPreference)&&controller.getTrayMenu()?.getMenuItemById('show-floating-ball')?.type==='checkbox'&&controller.getTrayMenu().getMenuItemById('show-floating-ball').checked===ballPreference);
    await run(main,()=>document.getElementById('desktopShowBallInput').click());
    await wait(async()=>!controller.state().settings.showFloatingBall&&!controller.getTrayMenu().getMenuItemById('show-floating-ball').checked&&await run(main,()=>{const input=document.getElementById('desktopShowBallInput');return input&&!input.disabled&&!input.checked;}));
    check('关闭显示悬浮球保持当前主界面并隐藏悬浮球，托盘勾选同步',main.isVisible()&&!controller.getWindows().ball.isVisible()&&controller.getWindows().ball.isDestroyed()===false);
    await run(main,()=>document.getElementById('desktopShowBallInput').click());
    await wait(async()=>controller.state().settings.showFloatingBall&&controller.getTrayMenu().getMenuItemById('show-floating-ball').checked&&await run(main,()=>{const input=document.getElementById('desktopShowBallInput');return input&&!input.disabled&&input.checked;}));
    check('重新开启显示悬浮球保存偏好，主界面打开时仍隐藏球体',main.isVisible()&&!controller.getWindows().ball.isVisible()&&await run(main,()=>document.getElementById('desktopShowBallInput').checked));
    const denied=await run(main,()=>slateDesktop.updateSettings({uiAccess:true}));check('未启用提权时拒绝 UIAccess，不写伪造权限或启动项',!!denied.runtime.error&&!denied.settings.uiAccess&&!denied.settings.uac&&!controller.state().settings.uiAccess&&!controller.state().settings.uac);
    const originalToken={elevated:controller.state().runtime.elevated,uiAccess:controller.state().runtime.uiAccess},startupPreference=controller.state().settings.autostartElevation;
    await run(main,()=>document.querySelector('#desktopElevationMethod input[value=compatibility]').click());
    await wait(async()=>controller.state().settings.uac&&controller.state().settings.manualElevation==='compatibility'&&await run(main,()=>!document.getElementById('desktopElevationMethod').disabled&&document.querySelector('#desktopElevationMethod input[value=compatibility]').checked));
    check('兼容性启用内部提权标记并显示指引，不申请进程提权或开启自启',!controller.state().settings.autostart&&!controller.state().runtime.error&&controller.state().settings.autostartElevation===startupPreference&&controller.state().runtime.elevated===originalToken.elevated&&controller.state().runtime.uiAccess===originalToken.uiAccess&&await run(main,()=>!document.getElementById('desktopUiAccessInput').disabled&&document.getElementById('desktopElevationMethod').closest('.desktop-elevation-method').nextElementSibling.matches('p.field-hint')));
    await run(main,()=>document.querySelector('#desktopElevationMethod input[value=uac]').click());
    const needsUac=!originalToken.elevated&&!originalToken.uiAccess;
    await wait(async()=>(needsUac?controller.state().runtime.error?.includes('验证模式'):controller.state().settings.manualElevation==='uac')&&await run(main,()=>!document.getElementById('desktopElevationMethod').disabled));
    check(needsUac?'验证模式拒绝 UAC 后恢复兼容性选择和原设置':'已有真实权限时 UAC 选项可保存，不伪造新的权限',controller.state().settings.uac&&controller.state().settings.manualElevation===(needsUac?'compatibility':'uac')&&controller.state().settings.autostartElevation===startupPreference&&!controller.state().settings.autostart&&controller.state().runtime.elevated===originalToken.elevated&&controller.state().runtime.uiAccess===originalToken.uiAccess&&await run(main,expected=>document.querySelector('#desktopElevationMethod input:checked').value===expected,needsUac?'compatibility':'uac'));
    if(!needsUac){await run(main,()=>document.querySelector('#desktopElevationMethod input[value=compatibility]').click());await wait(async()=>controller.state().settings.manualElevation==='compatibility'&&await run(main,()=>!document.getElementById('desktopElevationMethod').disabled));}
    // Only an already-present real UIAccess token can enable this without an authorization request.
    if(originalToken.uiAccess){const enabled=await run(main,()=>slateDesktop.updateSettings({uiAccess:true}));check('已有真实 UIAccess 令牌时可保存 UIAccess 偏好',enabled.settings.uiAccess&&!enabled.runtime.error);await wait(()=>run(main,()=>document.getElementById('desktopUiAccessInput').checked));}
    await run(main,()=>document.querySelector('#desktopElevationMethod input[value=disabled]').click());
    await wait(async()=>!controller.state().settings.uac&&await run(main,()=>!document.getElementById('desktopElevationMethod').disabled&&document.querySelector('#desktopElevationMethod input[value=disabled]').checked));
    check('禁用清除 UIAccess 并保留手动和自启提权偏好',!controller.state().settings.uiAccess&&controller.state().settings.manualElevation==='compatibility'&&controller.state().settings.autostartElevation===startupPreference&&await run(main,()=>{const input=document.getElementById('desktopUiAccessInput');return input.disabled&&!input.checked&&!document.getElementById('desktopElevationMethod').closest('.desktop-elevation-method').nextElementSibling.matches('p.field-hint');}));
    await run(main,()=>document.querySelector('#desktopElevationMethod input[value=compatibility]').click());
    await wait(async()=>controller.state().settings.uac&&await run(main,()=>!document.getElementById('desktopElevationMethod').disabled&&document.querySelector('#desktopElevationMethod input[value=compatibility]').checked));
    const beforeStartup={...controller.state().settings};
    await run(main,()=>document.getElementById('desktopAutostartInput').click());
    await wait(async()=>controller.state().runtime.error?.includes('验证模式')&&await run(main,()=>!document.getElementById('desktopAutostartInput').disabled&&!document.getElementById('desktopAutostartInput').checked));
    check('自启保存被拒绝后恢复手动选项与全部原设置，不留下计划任务选项',Object.entries(beforeStartup).every(([key,value])=>controller.state().settings[key]===value)&&await run(main,()=>!document.getElementById('desktopAutostartInput').checked&&document.querySelector('#desktopElevationMethod input[value=compatibility]').checked&&!document.querySelector('#desktopElevationMethod input[value=task]')&&Array.from(document.querySelectorAll('#desktopElevationMethod input'),input=>input.value).join('|')==='disabled|uac|compatibility'));
    await shot(main,'desktop-general-settings.png');
    await run(main,async()=>{await DialogTransitions.close(document.getElementById('configDialog'));const c=DrawCore.createEmptyState(477);c.settings.renderStyle='overview';c.settings.onboardingCompleted=true;slateDesktop.data.saveClass(DrawCore.restoreState(c));location.reload();});
    await wait(()=>run(main,()=>document.querySelector('.draw-screen')?.dataset.renderStyle==='overview'&&document.getElementById('liveBoardEmptyNotice')?.textContent.includes('名单不可用')));
    await wait(()=>run(main,()=>Number(getComputedStyle(document.getElementById('liveBoardEmptyNotice')).opacity)>.99),4000);
    check('全览在未配置时明确显示名单不可用，没有虚构座位',await run(main,()=>document.getElementById('liveBoardEmptyNotice').textContent.includes('名单不可用')&&document.querySelectorAll('.live-seat[data-live-student]').length===0&&document.getElementById('liveSeatMap').hidden&&!document.getElementById('liveSeatMap').style.transform.includes('Infinity')));
    await shot(main,'desktop-empty-overview.png');
    await run(main,()=>{const c=DrawCore.createState(Array.from({length:47},(_,i)=>({id:String(i+1),name:'同学'+(i+1),row:Math.floor(i/8)+1,col:i%8+1})),477);c.demo=false;c.settings.renderStyle='overview';slateDesktop.data.saveClass(DrawCore.restoreState(c));location.reload();});
    await wait(()=>run(main,()=>document.querySelector('.draw-screen')?.dataset.renderStyle==='overview'));await pause(300);
    check('全览关闭键与动作组合并且始终排在最左侧',await run(main,()=>{const g=document.querySelector('.home-actions'),close=document.getElementById('desktopCloseMainBtn').closest('.desktop-close-main'),draw=document.getElementById('drawBtn');return g.firstElementChild===close&&close.getBoundingClientRect().right<=draw.getBoundingClientRect().left+1&&getComputedStyle(close).position!=='fixed';}));
    check('托盘实际创建并提供主界面、设置和退出入口',typeof controller.getTray==='function'&&!controller.getTray().isDestroyed()&&typeof controller.getTrayMenu==='function'&&(()=>{const labels=controller.getTrayMenu().items.map(item=>item.label).join('|');return /主界面/.test(labels)&&/设置/.test(labels)&&/退出/.test(labels);})());
    await shot(main,'desktop-overview.png');
    check('真实桌面操作没有未处理 renderer/preload 错误',errors.length===0);
    await fs.writeFile(path.join(output,'desktop-report.json'),JSON.stringify({completedAt:new Date().toISOString(),checks,runtimeErrors:errors,screenshots:shots,nativeTouchReports,permissionsTest:'actual read-only token; settings prerequisite; no UAC or autostart system mutations'},null,2));
    console.log('Desktop QA complete: '+checks.length+' checks');app.exit(0);
  }catch(error){console.error(error);await fs.writeFile(path.join(output,'desktop-partial-report.json'),JSON.stringify({error:error.stack,checks,runtimeErrors:errors,screenshots:shots,nativeTouchReports},null,2));app.exit(1);}
});
