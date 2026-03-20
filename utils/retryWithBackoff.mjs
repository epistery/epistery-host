/**
 * Retry an async function on RPC rate limit errors with exponential backoff.
 */
export async function retryWithBackoff(fn, maxRetries = 3, baseDelay = 10000) {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        } catch (error) {
            const isRateLimit = error.code === 'SERVER_ERROR' &&
                               error.body &&
                               error.body.includes('rate limit');

            if (!isRateLimit || attempt === maxRetries) {
                throw error;
            }

            const delay = baseDelay * Math.pow(1.5, attempt);
            console.log(`Rate limit hit, retrying in ${delay/1000}s (attempt ${attempt + 1}/${maxRetries + 1})...`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
}
