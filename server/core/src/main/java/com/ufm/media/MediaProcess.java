package com.ufm.media;

import com.ufm.common.error.*;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.TimeUnit;

@Component
public class MediaProcess {
    private final String ffmpeg;
    public MediaProcess(@Value("${ufm.media.ffmpeg:${FFMPEG_PATH:ffmpeg}}") String ffmpeg) { this.ffmpeg=ffmpeg; }
    public void run(Path work,List<String> arguments) throws Exception {
        List<String> command=new ArrayList<>(List.of(ffmpeg,"-nostdin","-hide_banner","-loglevel","error","-y","-threads","1","-filter_threads","1"));
        command.addAll(arguments); Path log=work.resolve("ffmpeg.err");
        Process process=new ProcessBuilder(command).directory(work.toFile()).redirectOutput(ProcessBuilder.Redirect.DISCARD)
                .redirectError(log.toFile()).start();
        try {
            if (!process.waitFor(10,TimeUnit.MINUTES)) throw new ApiException(ErrorCode.UPSTREAM_TIMEOUT);
            if (process.exitValue()!=0) throw new ApiException(ErrorCode.INVALID_ARGUMENT,"Media conversion failed");
        } finally { if (process.isAlive()) process.destroyForcibly(); Files.deleteIfExists(log); }
    }
}
