package com.ufm.file;

import com.ufm.common.error.*;
import javax.xml.parsers.SAXParserFactory;
import org.xml.sax.helpers.DefaultHandler;
import java.nio.file.Path;
import java.util.zip.ZipFile;

public final class DocumentText {
    private static final int LIMIT=512*1024;
    private DocumentText() {}
    public static String extract(Path file,String mime) {
        if (!mime.equals("application/pdf")) return extractOffice(file);
        try (var document=org.apache.pdfbox.Loader.loadPDF(file.toFile(),org.apache.pdfbox.io.IOUtils.createTempFileOnlyStreamCache())) {
            if (document.isEncrypted() || !document.getCurrentAccessPermission().canExtractContent()) return "";
            StringBuilder output=new StringBuilder();
            var stripper=new org.apache.pdfbox.text.PDFTextStripper(); stripper.setEndPage(Math.min(500,document.getNumberOfPages()));
            try {
                stripper.writeText(document,new java.io.Writer() {
                    @Override public void write(char[] data,int offset,int length) throws java.io.IOException {
                        int remaining=LIMIT-output.length();
                        output.append(data,offset,Math.min(remaining,length));
                        if (length>remaining) throw new TextLimitReached();
                    }
                    @Override public void flush() {}
                    @Override public void close() {}
                });
            } catch (TextLimitReached bounded) { /* Only retain bounded searchable text. */ }
            return output.toString();
        } catch (java.io.IOException ex) { throw new ApiException(ErrorCode.INVALID_ARGUMENT,"Document text extraction failed"); }
    }
    private static class TextLimitReached extends java.io.IOException {}
    public static String extractOffice(Path file) {
        ArchiveSafety.check(file,10000,1024L*1024*1024);
        try (ZipFile zip=new ZipFile(file.toFile())) {
            SAXParserFactory factory=SAXParserFactory.newInstance(); factory.setNamespaceAware(true);
            factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl",true);
            factory.setFeature("http://xml.org/sax/features/external-general-entities",false);
            factory.setFeature("http://xml.org/sax/features/external-parameter-entities",false);
            factory.setFeature(javax.xml.XMLConstants.FEATURE_SECURE_PROCESSING,true);
            StringBuilder output=new StringBuilder();
            var entries=zip.entries(); int parsed=0;
            while (entries.hasMoreElements() && output.length()<LIMIT) {
                var entry=entries.nextElement(); String name=entry.getName();
                if (!name.matches("word/(document|header[0-9]*|footer[0-9]*)\\.xml|ppt/slides/slide[0-9]+\\.xml|xl/(sharedStrings|worksheets/sheet[0-9]+)\\.xml")) continue;
                if (++parsed>500) break;
                var parser=factory.newSAXParser(); parser.setProperty(javax.xml.XMLConstants.ACCESS_EXTERNAL_DTD,""); parser.setProperty(javax.xml.XMLConstants.ACCESS_EXTERNAL_SCHEMA,"");
                try (var input=zip.getInputStream(entry)) {
                    parser.parse(input,new DefaultHandler() {
                        @Override public void characters(char[] value,int start,int length) { if (output.length()<LIMIT) output.append(value,start,Math.min(length,LIMIT-output.length())); }
                        @Override public void endElement(String uri,String local,String qName) { if (output.length()<LIMIT) output.append(' '); }
                    });
                }
            }
            return output.toString();
        } catch (Exception ex) { throw new ApiException(ErrorCode.INVALID_ARGUMENT,"Document text extraction failed"); }
    }
}
