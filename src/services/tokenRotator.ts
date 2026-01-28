/**
 * TokenRotator - Round-robin rotation through Fleet GitHub PATs
 * Multiplies rate limit capacity (10 tokens = 50,000 req/hr)
 */
export class TokenRotator {
    private tokens: string[];
    private currentIndex: number;

    constructor(tokens: string[]) {
        if (!tokens || tokens.length === 0) {
            throw new Error('TokenRotator requires at least one token');
        }
        this.tokens = tokens;
        this.currentIndex = 0;
    }

    /**
     * Get next token in rotation using modulo arithmetic
     * Thread-safe for concurrent requests (single-threaded Node.js)
     */
    getNextToken(): string {
        const token = this.tokens[this.currentIndex];
        this.currentIndex = (this.currentIndex + 1) % this.tokens.length;
        return token;
    }

    /**
     * Get current token count
     */
    getTokenCount(): number {
        return this.tokens.length;
    }
}
