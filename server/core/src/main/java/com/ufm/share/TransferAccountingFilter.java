package com.ufm.share;

import jakarta.servlet.*;
import jakarta.servlet.http.*;
import org.springframework.stereotype.Component;
import org.springframework.core.annotation.Order;
import org.springframework.web.filter.OncePerRequestFilter;
import java.io.*;

@Component
@Order(org.springframework.core.Ordered.HIGHEST_PRECEDENCE+30)
public class TransferAccountingFilter extends OncePerRequestFilter {
    private final TransferAccounting accounting;
    public TransferAccountingFilter(TransferAccounting accounting) { this.accounting=accounting; }
    @Override protected void doFilterInternal(HttpServletRequest request,HttpServletResponse response,FilterChain chain) throws ServletException,IOException {
        Counting wrapper=new Counting(response); boolean failed=true;
        try { chain.doFilter(request,wrapper); failed=false; }
        finally {
            Object value=request.getAttribute(TransferAccounting.ATTRIBUTE);
            if (value instanceof TransferAccounting.Transfer transfer) accounting.finish(transfer,wrapper.bytes,wrapper.getStatus(),failed || wrapper.failed);
        }
    }
    private static class Counting extends HttpServletResponseWrapper {
        long bytes; boolean failed; ServletOutputStream stream;
        Counting(HttpServletResponse response) { super(response); }
        @Override public ServletOutputStream getOutputStream() throws IOException {
            if (stream!=null) return stream;
            var target=super.getOutputStream();
            stream=new ServletOutputStream() {
                @Override public boolean isReady() { return target.isReady(); }
                @Override public void setWriteListener(WriteListener listener) { target.setWriteListener(listener); }
                @Override public void write(int b) throws IOException { try { target.write(b); bytes++; } catch (IOException ex) { failed=true; throw ex; } }
                @Override public void write(byte[] data,int offset,int length) throws IOException { try { target.write(data,offset,length); bytes+=length; } catch (IOException ex) { failed=true; throw ex; } }
                @Override public void flush() throws IOException { try { target.flush(); } catch (IOException ex) { failed=true; throw ex; } }
                @Override public void close() throws IOException { try { target.close(); } catch (IOException ex) { failed=true; throw ex; } }
            }; return stream;
        }
    }
}
