'use strict';
// Exclude large event-loop gaps (for example hibernation) from a duration budget.
// Explicit wall-clock deadlines should use Date.now instead.
class ActiveClock {
 constructor({wall=Date.now,intervalMs=1000,gapMs=30000,schedule=true}={}) {
  this.wall=wall;this.intervalMs=intervalMs;this.gapMs=gapMs;this.last=wall();this.pausedMs=0;
  if(schedule){this.timer=setInterval(()=>this.tick(),intervalMs);this.timer.unref();}
 }
 tick(){const now=this.wall(),gap=Math.max(0,now-this.last);if(gap>this.gapMs)this.pausedMs+=gap-this.intervalMs;this.last=now;return now-this.pausedMs;}
 now(){return this.tick();}
 close(){clearInterval(this.timer);}
}
module.exports={ActiveClock};
