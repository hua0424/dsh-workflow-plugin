async page => {
  const measured = await page.evaluate(() => {
    const canvas = document.querySelector('.wf-canvas');
    const node = document.querySelector('.wf-node');
    return { canvas: canvas.getBoundingClientRect().toJSON(), nodePosition: getComputedStyle(node).position, viewport: {width: innerWidth, height: innerHeight}, overflow: document.documentElement.scrollWidth > innerWidth };
  });
  console.log(JSON.stringify(measured));
  if (measured.canvas.height < 350) throw Error('Canvas usable height must be at least 350px');
  if (measured.canvas.top >= measured.viewport.height - 150) throw Error('Canvas must be visible in first viewport');
  if (measured.nodePosition !== 'absolute') throw Error('Nodes must honor layout coordinates');
  if (measured.overflow) throw Error('Page must not overflow viewport horizontally');
}
