import { getCache, waitUntil } from '@vercel/functions';
import { createListHandler } from '../server/study-list.mjs';

export default createListHandler({ cache: getCache(), waitUntil });
