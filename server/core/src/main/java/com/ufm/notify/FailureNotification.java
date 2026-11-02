package com.ufm.notify;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.*;
import java.util.*;

@Service
public class FailureNotification {
    private final NotifyService notify;
    public FailureNotification(NotifyService notify) { this.notify=notify; }
    @Transactional(propagation=Propagation.REQUIRES_NEW)
    public void emit(UUID project,String event,Map<String,Object> data) { notify.failureEvent(project,event,data); }
}
