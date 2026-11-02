package com.ufm.file.search;

import com.huaban.analysis.jieba.JiebaSegmenter;

import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.regex.Pattern;

/**
 * Produces the space-delimited token stream stored in files.search_text.
 *
 * <p>PostgreSQL's simple text-search configuration then indexes each token.
 * Keeping tokenization in the application gives Chinese search quality without
 * adding an external search service.</p>
 */
public final class SearchTextTokenizer {

    public static final int MAX_CONTENT_BYTES = 512 * 1024;

    private static final Pattern SEARCHABLE_TOKEN = Pattern.compile("[\\p{L}\\p{N}]+");
    private static final JiebaSegmenter SEGMENTER = new JiebaSegmenter();

    public String tokenize(String content) {
        if (content == null || content.isBlank()) {
            return "";
        }

        String bounded = truncateUtf8(content.strip(), MAX_CONTENT_BYTES);
        StringBuilder tokens = new StringBuilder();
        int currentBytes = 0;
        synchronized (SEGMENTER) {
            for (String rawToken : SEGMENTER.sentenceProcess(bounded)) {
                String token = rawToken.strip().toLowerCase(Locale.ROOT);
                if (!SEARCHABLE_TOKEN.matcher(token).matches()) {
                    continue;
                }
                int separatorBytes = tokens.isEmpty() ? 0 : 1;
                int tokenBytes = token.getBytes(StandardCharsets.UTF_8).length;
                if (currentBytes + separatorBytes + tokenBytes > MAX_CONTENT_BYTES) {
                    break;
                }
                if (separatorBytes > 0) {
                    tokens.append(' ');
                }
                tokens.append(token);
                currentBytes += separatorBytes + tokenBytes;
            }
        }
        return tokens.toString();
    }

    private String truncateUtf8(String value, int maxBytes) {
        byte[] bytes = value.getBytes(StandardCharsets.UTF_8);
        if (bytes.length <= maxBytes) {
            return value;
        }
        return new String(bytes, 0, maxBytes, StandardCharsets.UTF_8);
    }
}
