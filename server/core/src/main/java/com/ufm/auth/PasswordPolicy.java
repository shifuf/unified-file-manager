package com.ufm.auth;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Pattern;

public final class PasswordPolicy {

    private static final Pattern DIGIT = Pattern.compile(".*\\d.*");
    private static final int MIN_CHARS = 10;
    private static final int MAX_BCRYPT_BYTES = 72;

    private PasswordPolicy() {
    }

    public static List<String> violations(String password) {
        List<String> violations = new ArrayList<>();
        if (password == null || password.length() < MIN_CHARS) {
            violations.add("密码至少需要 10 个字符");
        }
        if (password == null || !DIGIT.matcher(password).matches()) {
            violations.add("密码必须包含数字");
        }
        if (password != null && password.getBytes(StandardCharsets.UTF_8).length > MAX_BCRYPT_BYTES) {
            violations.add("密码不能超过 72 字节");
        }
        return List.copyOf(violations);
    }
}
