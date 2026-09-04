import { renderVideo } from './render-video';
const root = process.argv[2];
if (!root) throw new Error('usage: npm run render -- <projectRoot>');
console.log(await renderVideo(root));
