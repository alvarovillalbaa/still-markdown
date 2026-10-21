const origin = new URL(process.env.BASE_URL);
if (origin.protocol !== 'https:' || !origin.hostname.endsWith('.vercel.app')) throw new Error('Expected a Vercel HTTPS deployment.');
const expected = process.env.EXPECTED_REVISION;
if (!/^[a-f0-9]{40}$/.test(expected || '')) throw new Error('Expected a concrete Git revision.');
let last = 'No response';
for (let attempt = 0; attempt < 90; attempt++) {
  try {
    const response = await fetch(new URL('/api/config', origin), { signal: AbortSignal.timeout(10_000), cache: 'no-store' });
    const config = await response.json();
    if (response.ok && config.configured && config.revision === expected) {
      console.log(`Verified production revision ${expected}`);
      process.exit(0);
    }
    last = `HTTP ${response.status}; revision ${config.revision || 'missing'}`;
  } catch (error) { last = error.name; }
  await new Promise((resolve) => setTimeout(resolve, 5000));
}
throw new Error(`Production did not reach the requested revision: ${last}`);
